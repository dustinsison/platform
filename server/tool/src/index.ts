//
// Copyright © 2022 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import contact from '@hcengineering/contact'
import core, {
  BackupClient,
  Client as CoreClient,
  Doc,
  Domain,
  DOMAIN_MODEL,
  DOMAIN_TX,
  FieldIndex,
  Hierarchy,
  IndexKind,
  IndexOrder,
  MeasureContext,
  ModelDb,
  Tx,
  WorkspaceId
} from '@hcengineering/core'
import { consoleModelLogger, MigrateOperation, ModelLogger } from '@hcengineering/model'
import { createMongoTxAdapter, getMongoClient, getWorkspaceDB } from '@hcengineering/mongo'
import { buildStorageFromConfig, storageConfigFromEnv } from '@hcengineering/server'
import { StorageAdapter, StorageConfiguration } from '@hcengineering/server-core'
import { Db, Document } from 'mongodb'
import { connect } from './connect'
import toolPlugin from './plugin'
import { MigrateClientImpl } from './upgrade'

import fs from 'fs'
import path from 'path'

export * from './connect'
export * from './plugin'
export { toolPlugin as default }

export class FileModelLogger implements ModelLogger {
  handle: fs.WriteStream
  constructor (readonly file: string) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })

    this.handle = fs.createWriteStream(this.file, { flags: 'a' })
  }

  log (msg: string, data: any): void {
    this.handle.write(msg + ' : ' + JSON.stringify(data) + '\n')
  }

  error (msg: string, data: any): void {
    this.handle.write(msg + ': ' + JSON.stringify(data) + '\n')
  }

  close (): void {
    this.handle.close()
  }
}

/**
 * @public
 */
export function prepareTools (rawTxes: Tx[]): { mongodbUri: string, storageAdapter: StorageAdapter, txes: Tx[] } {
  const minioEndpoint = process.env.MINIO_ENDPOINT
  if (minioEndpoint === undefined) {
    console.error('please provide minio endpoint')
    process.exit(1)
  }

  const minioAccessKey = process.env.MINIO_ACCESS_KEY
  if (minioAccessKey === undefined) {
    console.error('please provide minio access key')
    process.exit(1)
  }

  const minioSecretKey = process.env.MINIO_SECRET_KEY
  if (minioSecretKey === undefined) {
    console.error('please provide minio secret key')
    process.exit(1)
  }

  const mongodbUri = process.env.MONGO_URL
  if (mongodbUri === undefined) {
    console.error('please provide mongodb url.')
    process.exit(1)
  }

  const storageConfig: StorageConfiguration = storageConfigFromEnv()

  const storageAdapter = buildStorageFromConfig(storageConfig, mongodbUri)

  return { mongodbUri, storageAdapter, txes: JSON.parse(JSON.stringify(rawTxes)) as Tx[] }
}

/**
 * @public
 */
export async function initModel (
  ctx: MeasureContext,
  transactorUrl: string,
  workspaceId: WorkspaceId,
  rawTxes: Tx[],
  migrateOperations: [string, MigrateOperation][],
  logger: ModelLogger = consoleModelLogger,
  skipOperations: boolean = false
): Promise<CoreClient | undefined> {
  const { mongodbUri, storageAdapter: minio, txes } = prepareTools(rawTxes)
  if (txes.some((tx) => tx.objectSpace !== core.space.Model)) {
    throw Error('Model txes must target only core.space.Model')
  }

  const _client = getMongoClient(mongodbUri)
  const client = await _client.getClient()
  let connection: CoreClient & BackupClient
  try {
    const db = getWorkspaceDB(client, workspaceId)

    logger.log('creating model...', workspaceId)
    const result = await db.collection(DOMAIN_TX).insertMany(txes as Document[])
    logger.log('model transactions inserted.', { count: result.insertedCount })

    logger.log('creating data...', { transactorUrl })
    const { model } = await fetchModelFromMongo(ctx, mongodbUri, workspaceId)

    logger.log('create minio bucket', { workspaceId })
    if (!(await minio.exists(ctx, workspaceId))) {
      await minio.make(ctx, workspaceId)
    }
    if (!skipOperations) {
      connection = (await connect(
        transactorUrl,
        workspaceId,
        undefined,
        {
          model: 'upgrade',
          admin: 'true'
        },
        model
      )) as unknown as CoreClient & BackupClient

      try {
        for (const op of migrateOperations) {
          logger.log('Migrate', { name: op[0] })
          await op[1].upgrade(connection, logger)
        }

        // Create update indexes
        await createUpdateIndexes(ctx, connection, db, logger)
      } catch (e: any) {
        logger.error('error', { error: e })
        throw e
      }
      return connection
    }
  } finally {
    _client.close()
  }
}

/**
 * @public
 */
export async function upgradeModel (
  ctx: MeasureContext,
  transactorUrl: string,
  workspaceId: WorkspaceId,
  rawTxes: Tx[],
  migrateOperations: [string, MigrateOperation][],
  logger: ModelLogger = consoleModelLogger,
  skipTxUpdate: boolean = false
): Promise<CoreClient> {
  const { mongodbUri, txes } = prepareTools(rawTxes)

  if (txes.some((tx) => tx.objectSpace !== core.space.Model)) {
    throw Error('Model txes must target only core.space.Model')
  }

  // const client = new MongoClient(mongodbUri)
  const _client = getMongoClient(mongodbUri)
  const client = await _client.getClient()
  try {
    const db = getWorkspaceDB(client, workspaceId)

    if (!skipTxUpdate) {
      logger.log('removing model...', { workspaceId: workspaceId.name })
      // we're preserving accounts (created by core.account.System).
      const result = await ctx.with(
        'mongo-delete',
        {},
        async () =>
          await db.collection(DOMAIN_TX).deleteMany({
            objectSpace: core.space.Model,
            modifiedBy: core.account.System,
            objectClass: { $nin: [contact.class.PersonAccount, 'contact:class:EmployeeAccount'] }
          })
      )
      logger.log('transactions deleted.', { workspaceId: workspaceId.name, count: result.deletedCount })

      logger.log('creating model...', { workspaceId: workspaceId.name })
      const insert = await ctx.with(
        'mongo-insert',
        {},
        async () => await db.collection(DOMAIN_TX).insertMany(txes as Document[])
      )

      logger.log('model transactions inserted.', { workspaceId: workspaceId.name, count: insert.insertedCount })
    }

    const { hierarchy, modelDb, model } = await fetchModelFromMongo(ctx, mongodbUri, workspaceId)

    await ctx.with('migrate', {}, async () => {
      const migrateClient = new MigrateClientImpl(db, hierarchy, modelDb, logger)
      for (const op of migrateOperations) {
        const t = Date.now()
        await op[1].migrate(migrateClient, logger)
        logger.log('migrate:', { workspaceId: workspaceId.name, operation: op[0], time: Date.now() - t })
      }
    })
    logger.log('Apply upgrade operations', { workspaceId: workspaceId.name })

    const connection = await ctx.with(
      'connect-platform',
      {},
      async (ctx) =>
        await connect(
          transactorUrl,
          workspaceId,
          undefined,
          {
            mode: 'backup',
            model: 'upgrade',
            admin: 'true'
          },
          model
        )
    )

    // Create update indexes
    await ctx.with('create-indexes', {}, async (ctx) => {
      await createUpdateIndexes(ctx, connection, db, logger)
    })

    await ctx.with('upgrade', {}, async () => {
      for (const op of migrateOperations) {
        const t = Date.now()
        await op[1].upgrade(connection, logger)
        logger.log('upgrade:', { operation: op[0], time: Date.now() - t, workspaceId: workspaceId.name })
      }
    })
    return connection
  } finally {
    _client.close()
  }
}

async function fetchModelFromMongo (
  ctx: MeasureContext,
  mongodbUri: string,
  workspaceId: WorkspaceId
): Promise<{ hierarchy: Hierarchy, modelDb: ModelDb, model: Tx[] }> {
  const hierarchy = new Hierarchy()
  const modelDb = new ModelDb(hierarchy)

  const txAdapter = await createMongoTxAdapter(ctx, hierarchy, mongodbUri, workspaceId, modelDb)

  const model = await ctx.with('get-model', {}, async (ctx) => await txAdapter.getModel(ctx))

  await ctx.with('build local model', {}, async () => {
    for (const tx of model) {
      try {
        hierarchy.tx(tx)
      } catch (err: any) {}
    }
    for (const tx of model) {
      try {
        await modelDb.tx(tx)
      } catch (err: any) {}
    }
  })
  await txAdapter.close()
  return { hierarchy, modelDb, model }
}

async function createUpdateIndexes (
  ctx: MeasureContext,
  connection: CoreClient,
  db: Db,
  logger: ModelLogger
): Promise<void> {
  const classes = await ctx.with('find-classes', {}, async () => await connection.findAll(core.class.Class, {}))

  const hierarchy = connection.getHierarchy()
  const domains = new Map<Domain, Set<string | FieldIndex<Doc>>>()
  // Find all domains and indexed fields inside
  for (const c of classes) {
    try {
      const domain = hierarchy.getDomain(c._id)
      if (domain === DOMAIN_MODEL) {
        continue
      }
      const attrs = hierarchy.getAllAttributes(c._id)
      const domainAttrs = domains.get(domain) ?? new Set<string | FieldIndex<Doc>>()
      for (const a of attrs.values()) {
        if (a.index !== undefined && (a.index === IndexKind.Indexed || a.index === IndexKind.IndexedDsc)) {
          if (a.index === IndexKind.Indexed) {
            domainAttrs.add(a.name)
          } else {
            domainAttrs.add({ [a.name]: IndexOrder.Descending })
          }
        }
      }

      // Handle extra configurations
      if (hierarchy.hasMixin(c, core.mixin.IndexConfiguration)) {
        const config = hierarchy.as(c, core.mixin.IndexConfiguration)
        for (const attr of config.indexes) {
          domainAttrs.add(attr)
        }
      }

      domains.set(domain, domainAttrs)
    } catch (err: any) {
      // Ignore, since we have classes without domain.
    }
  }

  const collections = await ctx.with(
    'list-collections',
    {},
    async () => await db.listCollections({}, { nameOnly: true }).toArray()
  )
  for (const [d, v] of domains.entries()) {
    const collInfo = collections.find((it) => it.name === d)
    if (collInfo == null) {
      await ctx.with('create-collection', { d }, async () => await db.createCollection(d))
    }
    const collection = db.collection(d)
    const bb: (string | FieldIndex<Doc>)[] = []
    for (const vv of v.values()) {
      try {
        const key = typeof vv === 'string' ? vv : Object.keys(vv)[0]
        const name = typeof vv === 'string' ? `${key}_1` : `${key}_${vv[key]}`
        const exists = await collection.indexExists(name)
        if (!exists) {
          await collection.createIndex(vv)
          bb.push(vv)
        }
      } catch (err: any) {
        logger.error('error: failed to create index', { d, vv, err })
      }
    }
    if (bb.length > 0) {
      logger.log('created indexes', { d, bb })
    }
  }
}
