// Code snippets (built-in + user defined, stored in <userData>/snippets.json)

export interface Snippet {
  id: string;
  name: string;
  description: string;
  /** SQL text; Monaco snippet syntax (${1:placeholder}) is supported */
  sql: string;
  group: string;
  builtIn?: boolean;
}

export interface SnippetsApi {
  list(): Promise<Snippet[]>;
  save(snippet: Snippet): Promise<Snippet>;
  remove(id: string): Promise<void>;
}
