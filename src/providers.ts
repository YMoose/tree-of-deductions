import * as vscode from 'vscode';
import { RationaleStore, StoredEdge } from './rationaleStore';

export const SHOW_INCOMING_COMMAND = 'treeofdeductions.showIncomingRationale';

/** Locations of the `from` ends of `edges`, clamped to their documents. */
async function fromLocations(store: RationaleStore, edges: readonly StoredEdge[]): Promise<vscode.Location[]> {
    const locations: vscode.Location[] = [];
    for (const edge of edges) {
        const uri = store.endpointUri(edge, 'from');
        locations.push(new vscode.Location(uri, await clampedRange(uri, store.endpointRange(edge, 'from'))));
    }
    return locations;
}

/** Shift+F12 / right-click "Find References" lists everything a rationale edge points at. */
export class RationaleReferenceProvider implements vscode.ReferenceProvider {
    constructor(private readonly store: RationaleStore) {}

    async provideReferences(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
        const locations = await fromLocations(this.store, this.store.incomingAt(document.uri, position));
        return locations.length > 0 ? locations : undefined;
    }
}

/** `N rationale references` above every range that edges point at; click opens the peek list. */
export class RationaleCodeLensProvider implements vscode.CodeLensProvider {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changeEmitter.event;

    constructor(private readonly store: RationaleStore) {
        store.onDidChange(() => this.changeEmitter.fire());
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        // Group edges by target range so several sources behind the same range yield one lens.
        const groups = new Map<string, { range: vscode.Range; count: number }>();
        for (const edge of this.store.incomingTo(document.uri)) {
            const range = this.store.endpointRange(edge, 'to');
            const key = `${range.start.line}-${range.end.line}`;
            const group = groups.get(key) ?? { range, count: 0 };
            group.count += 1;
            groups.set(key, group);
        }
        return [...groups.values()].map(({ range, count }) => new vscode.CodeLens(range, {
            title: `${count} rationale reference${count === 1 ? '' : 's'}`,
            command: SHOW_INCOMING_COMMAND,
            arguments: [document.uri, new vscode.Position(range.start.line, 0)],
        }));
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}

/** Hovering inside a pointed-at range lists each rationale and where it comes from. */
export class RationaleHoverProvider implements vscode.HoverProvider {
    constructor(private readonly store: RationaleStore) {}

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const edges = this.store.incomingAt(document.uri, position);
        if (edges.length === 0) {
            return undefined;
        }
        const contents = edges.map(edge => {
            const [start] = edge.from.lines;
            return new vscode.MarkdownString(`**${edge.from.file}:${start}**\n\n${edge.rationale}`);
        });
        return new vscode.Hover(contents);
    }
}

/** Opens the built-in peek-references widget for everything pointing at `position`. */
export async function showIncomingRationale(store: RationaleStore, uri: vscode.Uri, position: vscode.Position): Promise<void> {
    const locations = await fromLocations(store, store.incomingAt(uri, position));
    if (locations.length === 0) {
        return;
    }
    await vscode.commands.executeCommand('editor.action.showReferences', uri, position, locations);
}

/** Clamps `range` to the document's line count; falls back to the raw range if the file is unreadable. */
async function clampedRange(uri: vscode.Uri, range: vscode.Range): Promise<vscode.Range> {
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        const lastLine = document.lineCount - 1;
        return new vscode.Range(
            Math.min(range.start.line, lastLine), range.start.character,
            Math.min(range.end.line, lastLine), range.end.character,
        );
    } catch {
        return range;
    }
}
