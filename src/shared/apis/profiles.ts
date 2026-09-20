// Saved profiles (import/export/transfer/sync/… settings) stored as JSON files
// in <profilesDir>/profiles/<kind>/<name>.json

export interface ProfileInfo {
  kind: string;
  name: string;
  mtime: number;
}

export interface ProfilesApi {
  list(kind: string): Promise<ProfileInfo[]>;
  load(kind: string, name: string): Promise<unknown>;
  save(kind: string, name: string, data: unknown): Promise<void>;
  remove(kind: string, name: string): Promise<void>;
}
