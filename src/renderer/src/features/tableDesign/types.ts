// Props shared by the panes of the table designer.

import type { ServerInfo, TableDesign } from '@shared/types';
import type { ServerFeatures } from './model';
import type { ServerLists } from './serverLists';

export type UpdateDesign = (fn: (e: TableDesign) => TableDesign) => void;

export interface PaneProps {
  connectionId: string;
  database: string;
  /** Editing form of the design (references by field id) */
  edit: TableDesign;
  update: UpdateDesign;
  server?: ServerInfo;
  features: ServerFeatures;
  lists: ServerLists;
  /** ids of objects with validation problems */
  problems: Set<string>;
}
