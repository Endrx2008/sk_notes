import { ItemView } from './base.js';
export class GraphView extends ItemView { getViewType() { return 'graph'; } getDisplayText() { return 'GraphView'; } }
export class LocalGraphView extends ItemView { getViewType() { return 'graph'; } getDisplayText() { return 'LocalGraphView'; } }
