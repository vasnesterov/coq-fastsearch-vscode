import * as vscode from 'vscode';
import { CoqProcess } from './coqRunner';

export class SearchPanel {
    private static currentPanel: SearchPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private coq: CoqProcess;
    private disposed = false;

    static createOrShow(context: vscode.ExtensionContext) {
        if (SearchPanel.currentPanel) {
            SearchPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'coqFastSearch',
            'Coq FastSearch',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );
        SearchPanel.currentPanel = new SearchPanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this.panel = panel;
        this.context = context;
        this.coq = new CoqProcess();
        this.panel.webview.html = this.getHtml();

        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'search') {
                await this.handleSearch(msg.query);
            } else if (msg.type === 'loadmore') {
                this.handleLoadMore();
            } else if (msg.type === 'restart') {
                await this.initCoq();
            }
        });

        this.panel.onDidDispose(() => {
            this.disposed = true;
            this.coq.kill();
            SearchPanel.currentPanel = undefined;
        });

        this.initCoq();
    }

    private async initCoq() {
        this.panel.webview.postMessage({ type: 'loading' });

        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.fileName.endsWith('.v')
        );

        const preamble = editor ? this.getPreamble(editor) : '';

        try {
            await this.coq.start(preamble);
            if (!this.disposed) {
                this.panel.webview.postMessage({ type: 'ready' });
            }
        } catch (err: unknown) {
            if (!this.disposed) {
                const text = err instanceof Error ? err.message : String(err);
                this.panel.webview.postMessage({ type: 'error', text: `Failed to start: ${text}` });
            }
        }
    }

    private async handleSearch(query: string) {
        if (!query.trim()) { return; }

        if (!this.coq.ready) {
            this.panel.webview.postMessage({ type: 'error', text: 'Search not ready. Click Restart.' });
            return;
        }

        this.panel.webview.postMessage({ type: 'searching' });

        try {
            const results = await this.coq.search(query);
            if (!this.disposed) {
                this.panel.webview.postMessage({
                    type: 'results', results, total: this.coq.total, hasMore: this.coq.hasMore
                });
            }
        } catch (err: unknown) {
            if (!this.disposed) {
                const text = err instanceof Error ? err.message : String(err);
                this.panel.webview.postMessage({ type: 'error', text });
            }
        }
    }

    private handleLoadMore() {
        const results = this.coq.nextPage();
        if (!this.disposed) {
            this.panel.webview.postMessage({
                type: 'more', results, hasMore: this.coq.hasMore
            });
        }
    }

    private getPreamble(editor: vscode.TextEditor): string {
        const doc = editor.document;
        const cursorLine = editor.selection.active.line;
        const lines: string[] = [];
        for (let i = 0; i <= cursorLine; i++) {
            const line = doc.lineAt(i).text;
            if (/^\s*(From|Require|Import|Export|Set|Unset|Open|Close|Declare)\b/.test(line)) {
                lines.push(line);
            }
        }
        return lines.join('\n');
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; }
    #toolbar { display: flex; gap: 6px; align-items: center; }
    #search-box { flex: 1; padding: 6px 8px; box-sizing: border-box;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border); font-size: 13px; }
    #restart-btn { padding: 4px 10px; cursor: pointer; font-size: 12px;
        background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
        border: none; }
    #status { margin: 8px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
    #results { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 13px); }
    .result { padding: 3px 0; white-space: pre-wrap; }
    .result-name { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
    .result-type { color: var(--vscode-foreground); }
    .error { color: var(--vscode-errorForeground); }
    #load-more { display: none; margin: 10px 0; padding: 4px 12px; cursor: pointer;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border: none; }
</style>
</head>
<body>
    <div id="toolbar">
        <input id="search-box" type="text" placeholder="Search (e.g. addn, _ + _, &quot;mul&quot;)" disabled />
        <button id="restart-btn">Restart</button>
    </div>
    <div id="status">Loading...</div>
    <div id="results"></div>
    <button id="load-more">Load more</button>
<script>
    const vscode = acquireVsCodeApi();
    const searchBox = document.getElementById('search-box');
    const statusEl = document.getElementById('status');
    const resultsEl = document.getElementById('results');
    const loadMoreBtn = document.getElementById('load-more');
    const restartBtn = document.getElementById('restart-btn');

    let allResults = [];

    let debounceTimer;
    searchBox.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            vscode.postMessage({ type: 'search', query: searchBox.value });
        }, 300);
    });

    searchBox.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            clearTimeout(debounceTimer);
            vscode.postMessage({ type: 'search', query: searchBox.value });
        }
    });

    loadMoreBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'loadmore' });
    });

    restartBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'restart' });
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'loading') {
            statusEl.textContent = 'Search is loading...';
            searchBox.disabled = true;
            resultsEl.innerHTML = '';
            loadMoreBtn.style.display = 'none';
        } else if (msg.type === 'ready') {
            statusEl.textContent = 'Ready';
            searchBox.disabled = false;
            searchBox.focus();
        } else if (msg.type === 'searching') {
            statusEl.textContent = 'Searching...';
            resultsEl.innerHTML = '';
            loadMoreBtn.style.display = 'none';
        } else if (msg.type === 'results') {
            allResults = msg.results;
            resultsEl.innerHTML = '';
            const total = msg.total || allResults.length;
            statusEl.textContent = 'Showing ' + allResults.length + ' of ' + total + ' results';
            appendResults(allResults);
            loadMoreBtn.style.display = msg.hasMore ? 'block' : 'none';
        } else if (msg.type === 'more') {
            allResults = allResults.concat(msg.results);
            const total = document.getElementById('status').textContent.match(/of (\d+)/);
            appendResults(msg.results);
            statusEl.textContent = 'Showing ' + allResults.length + ' of ' + (total ? total[1] : allResults.length) + ' results';
            loadMoreBtn.style.display = msg.hasMore ? 'block' : 'none';
        } else if (msg.type === 'error') {
            statusEl.textContent = '';
            resultsEl.innerHTML = '<div class="error">' + escapeHtml(msg.text) + '</div>';
            loadMoreBtn.style.display = 'none';
        }
    });

    function appendResults(results) {
        for (const r of results) {
            const div = document.createElement('div');
            div.className = 'result';
            div.innerHTML = '<span class="result-name">' + escapeHtml(r.name) + '</span>: <span class="result-type">' + escapeHtml(r.type) + '</span>';
            resultsEl.appendChild(div);
        }
    }

    function escapeHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
</script>
</body>
</html>`;
    }
}
