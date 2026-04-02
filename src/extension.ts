import * as vscode from 'vscode';
import { SearchPanel } from './searchPanel';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('coq-fastsearch.open', () => {
            SearchPanel.createOrShow(context);
        })
    );
}

export function deactivate() {}
