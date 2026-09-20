// RPC namespaces of feature modules. Each feature owns its interface file and extends it:
//   users      → src/shared/apis/users.ts       (user & privilege management)
//   io         → src/shared/apis/io.ts          (import / export / dump / execute SQL file)
//   sync       → src/shared/apis/sync.ts        (data transfer, data sync, structure sync)
//   admin      → src/shared/apis/admin.ts       (server monitor, find in database, console helpers)
//   backup     → src/shared/apis/backup.ts      (backup / restore / extract)
//   automation → src/shared/apis/automation.ts  (batch jobs, scheduling, e-mail)
//   datagen    → src/shared/apis/datagen.ts     (test data generator)
//   model      → src/shared/apis/model.ts       (data modeling helpers)

export type { UsersApi } from './users';
export type { IoApi } from './io';
export type { SyncApi } from './sync';
export type { AdminApi } from './admin';
export type { BackupApi } from './backup';
export type { AutomationApi } from './automation';
export type { DataGenApi } from './datagen';
export type { ModelApi } from './model';
