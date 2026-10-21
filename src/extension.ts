// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { RationaleStore } from './rationaleStore';
import {
	RationaleCodeLensProvider,
	RationaleHoverProvider,
	RationaleReferenceProvider,
	SHOW_INCOMING_COMMAND,
	showIncomingRationale,
} from './providers';
import { CurrentFileProvider, DeductionOverviewProvider, REVEAL_ENDPOINT_COMMAND, revealEndpoint } from './deductionTree';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "tree-of-deductions" is now active!');

	// Rationale edges: read-only navigation over .treeofdeductions/rationale.json
	const store = new RationaleStore();
	store.start();

	const lensProvider = new RationaleCodeLensProvider(store);

	// Deduction views: the tree rooted at source propositions + the active file's From/To.
	const overviewTree = new DeductionOverviewProvider(store);
	const overviewView = vscode.window.createTreeView('treeofdeductions.overview', { treeDataProvider: overviewTree });
	overviewTree.onDidChangeTreeData(() => {
		overviewView.message = overviewTree.message || undefined;
	});
	const currentFileTree = new CurrentFileProvider(store);
	const currentFileView = vscode.window.createTreeView('treeofdeductions.currentFile', { treeDataProvider: currentFileTree });
	currentFileTree.onDidChangeTreeData(() => {
		currentFileView.message = currentFileTree.message || undefined;
	});

	context.subscriptions.push(
		store,
		lensProvider,
		overviewView,
		currentFileView,
		vscode.languages.registerCodeLensProvider('*', lensProvider),
		vscode.languages.registerReferenceProvider('*', new RationaleReferenceProvider(store)),
		vscode.languages.registerHoverProvider('*', new RationaleHoverProvider(store)),
		vscode.commands.registerCommand(SHOW_INCOMING_COMMAND, (uri: vscode.Uri, position: vscode.Position) =>
			showIncomingRationale(store, uri, position)),
		vscode.commands.registerCommand(REVEAL_ENDPOINT_COMMAND, revealEndpoint),
		// Manual re-parse for cases the file watcher does not cover.
		vscode.commands.registerCommand('treeofdeductions.reloadRationale', () => {
			void store.reload().then(() => {
				void vscode.window.showInformationMessage(`Reloaded ${store.edgeCount} rationale edges.`);
			});
		}),
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
