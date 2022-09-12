import _ from 'lodash'
import fs from 'fs'
import inquirer from 'inquirer'
import path from 'path'
import colors from 'colors'
import { register } from 'ts-node'

import mongoose, { Connection, FilterQuery, HydratedDocument, LeanDocument, Model } from 'mongoose'

import IArgs from './interfaces/IArgs'
import IFileError from './interfaces/IFileError'
import IMigration from './interfaces/IMigration'
import IMigratorOptions from './interfaces/IMigratorOptions'

import { registerOptions } from './options'
import { getMigrationModel } from './model'

colors.enable()
register(registerOptions)

const defaultTemplate = `/**
 * Make any changes you need to make to the database here
 */
export async function up () {
  // Write migration here
}

/**
 * Make any changes that UNDO the up function side effects here (if possible)
 */
export async function down () {
  // Write migration here
}
`

class Migrator {
  template?: string
  migrationPath: string
  connection: Connection
  collection: string
  autosync: boolean
  cli: boolean
  migrationModel: Model<IMigration>

  constructor (options: IMigratorOptions) {
    this.template = options.templatePath ? fs.readFileSync(options.templatePath, 'utf-8') : defaultTemplate
    this.migrationPath = path.resolve(options.migrationsPath || './migrations')
    this.connection = options.connection || mongoose.createConnection(options.connectionString, { autoCreate: true })
    this.collection = options.collection || 'migrations'
    this.autosync = options.autosync || false
    this.cli = options.cli
    this.migrationModel = getMigrationModel(this.collection, this.connection)

    if (!fs.existsSync(this.migrationPath)) {
      fs.mkdirSync(this.migrationPath, { recursive: true })
    }
  }

  log (logString: string, force = false) {
    if (force || this.cli) {
      console.log(logString)
    }
  }

  fileError (error: IFileError): void {
    if (error && error.code === 'ENOENT') {
      throw new ReferenceError(`Could not find any files at path '${error.path}'`)
    }
  }

  /**
   * Use your own Mongoose connection object (so you can use this('modelname')
   * @param {mongoose.connection} connection - Mongoose connection
   */
  setMongooseConnection (connection: Connection): Migrator {
    this.migrationModel = getMigrationModel(this.collection, connection)
    return this
  }

  /**
   * Close the underlying connection to mongo
   * @returns {Promise<void>} A promise that resolves when connection is closed
   */
  async close (): Promise<void> {
    if (this.connection) {
      await this.connection.close()
    }
  }

  /**
   * Create a new migration
   * @param {string} migrationName
   * @returns {Promise<Object>} A promise of the Migration created
   */
  async create (migrationName: string): Promise<HydratedDocument<IMigration>> {
    try {
      const existingMigration = await this.migrationModel.findOne({ name: migrationName })
      if (existingMigration) {
        throw new Error(`There is already a migration with name '${migrationName}' in the database`.red)
      }

      await this.sync()
      const now = Date.now()
      const newMigrationFile = `${now}-${migrationName}.ts`
      fs.writeFileSync(path.join(this.migrationPath, newMigrationFile), this.template)
      // create instance in db
      await this.connection.asPromise()
      const migrationCreated = await this.migrationModel.create({
        name: migrationName,
        createdAt: now
      })
      this.log(`Created migration ${migrationName} in ${this.migrationPath}.`)
      return migrationCreated
    } catch (error) {
      this.log(error.stack)
      this.fileError(error)
    }
  }

  /**
   * Runs migrations up to or down to a given migration name
   * @param migrationName
   * @param direction
   */
  async run (direction = 'up', migrationName?: string, ...args: IArgs[]): Promise<LeanDocument<IMigration>[]> {
    await this.sync()

    if (direction !== 'up' && direction !== 'down') {
      throw new Error(`The '${direction}' is not supported, use the 'up' or 'down' direction`)
    }

    const untilMigration = migrationName
      ? await this.migrationModel.findOne({ name: migrationName })
      : await this.migrationModel.findOne().sort({ createdAt: direction === 'up' ? -1 : 1 })

    if (!untilMigration) {
      if (migrationName) throw new ReferenceError('Could not find that migration in the database')
      else throw new Error('There are no pending migrations.')
    }

    let query: FilterQuery<IMigration> = {
      createdAt: { $lte: untilMigration.createdAt },
      state: 'down'
    }

    if (direction === 'down') {
      query = {
        createdAt: { $gte: untilMigration.createdAt },
        state: 'up'
      }
    }

    const sortDirection = direction === 'up' ? 1 : -1
    const migrationsToRun = await this.migrationModel.find(query)
      .sort({ createdAt: sortDirection })

    if (!migrationsToRun.length) {
      if (this.cli) {
        this.log('There are no migrations to run'.yellow)
        this.log('Current Migrations\' Statuses: ')
        await this.list()
      }
    }

    let numMigrationsRan = 0
    const migrationsRan: LeanDocument<IMigration>[] = []

    for (const migration of migrationsToRun) {
      const migrationFilePath = path.join(this.migrationPath, migration.filename)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const migrationFunctions = require(migrationFilePath)

      if (!migrationFunctions[direction]) {
        throw new Error(`The "${direction}" export is not defined in ${migration.filename}.`.red)
      }

      try {
        await new Promise((resolve, reject) => {
          const callPromise = migrationFunctions[direction].call(
            this.connection.model.bind(this.connection),
            function callback (err: Error) {
              if (err) return reject(err)
              resolve(null)
            },
            ...args
          )

          if (callPromise && typeof callPromise.then === 'function') {
            callPromise.then(resolve).catch(reject)
          }
        })

        this.log(`${direction.toUpperCase()}:   `[direction === 'up' ? 'green' : 'red'] + ` ${migration.filename} `)

        await this.migrationModel.where({ name: migration.name }).updateMany({ $set: { state: direction } })
        migrationsRan.push(migration.toJSON())
        numMigrationsRan++
      } catch (err) {
        this.log(`Failed to run migration ${migration.name} due to an error.`.red)
        this.log('Not continuing. Make sure your data is in consistent state'.red)
        throw err instanceof (Error) ? err : new Error(err)
      }
    }

    if (migrationsToRun.length === numMigrationsRan && numMigrationsRan > 0) this.log('All migrations finished successfully.'.green)
    return migrationsRan
  }

  /**
   * Looks at the file system migrations and imports any migrations that are
   * on the file system but missing in the database into the database
   *
   * This functionality is opposite of prune()
   */
  async sync (): Promise<LeanDocument<IMigration>[]> {
    try {
      const filesInMigrationFolder = fs.readdirSync(this.migrationPath)
      const migrationsInDatabase = await this.migrationModel.find({})
      // Go over migrations in folder and delete any files not in DB
      const migrationsInFolder = _.filter(filesInMigrationFolder, (file) => /\d{13,}-.+.ts$/.test(file))
        .map((filename) => {
          const fileCreatedAt = parseInt(filename.split('-')[0])
          const existsInDatabase = migrationsInDatabase.some((m) => filename === m.filename)
          return { createdAt: fileCreatedAt, filename, existsInDatabase }
        })

      const filesNotInDb: string[] = _.filter(migrationsInFolder, { existsInDatabase: false }).map((f) => f.filename)
      let migrationsToImport = filesNotInDb
      this.log('Synchronizing database with file system migrations...')
      if (!this.autosync && migrationsToImport.length) {
        const answers: { migrationsToImport: string[] } = await inquirer.prompt({
          type: 'checkbox',
          message: 'The following migrations exist in the migrations folder but not in the database. Select the ones you want to import into the database',
          name: 'migrationsToImport',
          choices: filesNotInDb
        })

        migrationsToImport = answers.migrationsToImport
      }

      const promises = migrationsToImport.map(async (migrationToImport) => {
        const filePath = path.join(this.migrationPath, migrationToImport)
        const timestampSeparatorIndex = migrationToImport.indexOf('-')
        const timestamp = migrationToImport.slice(0, timestampSeparatorIndex)
        const migrationName = migrationToImport.slice(timestampSeparatorIndex + 1, migrationToImport.lastIndexOf('.'))

        this.log(`Adding migration ${filePath} into database from file system. State is ` + 'down'.red)
        const createdMigration = await this.migrationModel.create({
          name: migrationName,
          createdAt: timestamp
        })
        return createdMigration.toJSON()
      })

      return Promise.all(promises)
    } catch (error) {
      this.log('Could not synchronize migrations in the migrations folder up to the database.'.red)
      throw error
    }
  }

  /**
   * Opposite of sync().
   * Removes files in migration directory which don't exist in database.
   */
  async prune () {
    try {
      const filesInMigrationFolder = fs.readdirSync(this.migrationPath)
      const migrationsInDatabase = await this.migrationModel.find({})
      // Go over migrations in folder and delete any files not in DB
      const migrationsInFolder = _.filter(filesInMigrationFolder, (file) => /\d{13,}-.+.ts/.test(file))
        .map((filename) => {
          const fileCreatedAt = parseInt(filename.split('-')[0])
          const existsInDatabase = migrationsInDatabase.some((m) => filename === m.filename)
          return { createdAt: fileCreatedAt, filename, existsInDatabase }
        })

      const dbMigrationsNotOnFs = _.filter(migrationsInDatabase, (m) => {
        return !_.find(migrationsInFolder, { filename: m.filename })
      })

      let migrationsToDelete = dbMigrationsNotOnFs.map((m) => m.name)

      if (!this.autosync && migrationsToDelete.length) {
        const answers: { migrationsToDelete: string[] } = await inquirer.prompt({
          type: 'checkbox',
          message: 'The following migrations exist in the database but not in the migrations folder. Select the ones you want to remove from the file system.',
          name: 'migrationsToDelete',
          choices: migrationsToDelete
        })

        migrationsToDelete = answers.migrationsToDelete
      }

      const migrationsToDeleteDocs = await this.migrationModel.find({ name: { $in: migrationsToDelete } }).lean()

      if (migrationsToDelete.length) {
        this.log(`Removing migration(s) from database: \n${migrationsToDelete.join('\n, ').cyan} `)
        await this.migrationModel.deleteMany({ name: { $in: migrationsToDelete } })
      }

      return migrationsToDeleteDocs
    } catch (error) {
      this.log('Could not prune extraneous migrations from database.'.red)
      throw error
    }
  }

  /**
   * @example
   *   [
   *    { name: 'my-migration', filename: '149213223424_my-migration.ts', state: 'up' },
   *    { name: 'add-cows', filename: '149213223453_add-cows.ts', state: 'down' }
   *   ]
   */
  async list (): Promise<LeanDocument<IMigration>[]> {
    await this.sync()
    const migrations = await this.migrationModel.find().sort({ createdAt: 1 }).exec()
    if (!migrations.length) this.log('There are no migrations to list.'.yellow)
    return migrations.map((migration: HydratedDocument<IMigration>) => {
      this.log(
        `${migration.state}: `[migration.state === 'up' ? 'green' : 'red'] + `${migration.filename}`
      )
      return migration.toJSON()
    })
  }
}

export default Migrator
