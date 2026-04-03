import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SearchResult {
    name: string;
    type: string;
}

export class CoqProcess {
    private proc: ChildProcess | null = null;
    private buffer: string = '';
    private resolveReady: ((output: string) => void) | null = null;
    private rejectReady: ((err: Error) => void) | null = null;
    private _ready: boolean = false;

    get ready(): boolean { return this._ready; }

    async start(preamble: string): Promise<void> {
        this.kill();
        this.buffer = '';
        this._ready = false;

        this.proc = spawn('coqtop', ['-q'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.proc.stdout!.on('data', (data) => {
            this.buffer += data.toString();
            this.checkPrompt();
        });

        this.proc.stderr!.on('data', (data) => {
            this.buffer += data.toString();
            this.checkPrompt();
        });

        this.proc.on('error', (err) => {
            if (this.rejectReady) {
                this.rejectReady(err);
                this.resolveReady = null;
                this.rejectReady = null;
            }
        });

        this.proc.on('exit', () => {
            this._ready = false;
            if (this.rejectReady) {
                this.rejectReady(new Error('coqtop exited unexpectedly'));
                this.resolveReady = null;
                this.rejectReady = null;
            }
        });

        // Wait for initial prompt
        await this.waitForPrompt();

        // Send preamble
        const lines = preamble.split('\n').filter(l => l.trim());
        for (const line of lines) {
            await this.sendCommand(line);
        }

        // No need to load FastSearch — we use the built-in Search + Redirect

        this._ready = true;
    }

    private resultFile: string = '';
    private cachedResults: SearchResult[] = [];
    private returnedCount: number = 0;
    private static readonly PAGE_SIZE = 100;

    get total(): number { return this.cachedResults.length; }
    get hasMore(): boolean { return this.returnedCount < this.cachedResults.length; }

    async search(query: string): Promise<SearchResult[]> {
        if (!this.proc || !this._ready) {
            throw new Error('coqtop not ready');
        }

        const q = query.trim();

        this.cleanResultFile();

        this.resultFile = path.join(os.tmpdir(), `fastsearch-${Date.now()}`);
        const output = await this.sendCommand(`Redirect "${this.resultFile}" Search ${q}.`);

        // Check for Coq errors in the coqtop output
        const errorMatch = output.match(/^Error:\s*(.*)/m) || output.match(/^Syntax error:\s*(.*)/m);
        if (errorMatch) {
            throw new Error(errorMatch[0].trim());
        }

        const outFile = this.resultFile + '.out';
        if (!fs.existsSync(outFile)) {
            // Extract any useful message from coqtop output
            const msg = output.replace(/^Toplevel input.*\n?/gm, '').replace(/^>.*\n?/gm, '').trim();
            throw new Error(msg || 'Search failed');
        }

        const fullOutput = fs.readFileSync(outFile, 'utf-8');
        this.cachedResults = parseResults(fullOutput);
        this.returnedCount = 0;

        return this.nextPage();
    }

    nextPage(): SearchResult[] {
        const end = Math.min(this.returnedCount + CoqProcess.PAGE_SIZE, this.cachedResults.length);
        const page = this.cachedResults.slice(this.returnedCount, end);
        this.returnedCount = end;
        return page;
    }

    private cleanResultFile() {
        if (this.resultFile) {
            try { fs.unlinkSync(this.resultFile + '.out'); } catch {}
            this.resultFile = '';
        }
    }

    private sendCommand(cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.proc || !this.proc.stdin!.writable) {
                reject(new Error('coqtop not running'));
                return;
            }
            this.buffer = '';
            this.resolveReady = resolve;
            this.rejectReady = reject;
            this.proc.stdin!.write(cmd + '\n');
        });
    }

    private waitForPrompt(): Promise<string> {
        return new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
            // Check if prompt is already in buffer
            this.checkPrompt();
        });
    }

    private checkPrompt() {
        // coqtop prompt is "Coq < " at the end of output
        const promptIdx = this.buffer.lastIndexOf('Coq < ');
        if (promptIdx !== -1 && this.resolveReady) {
            const output = this.buffer.substring(0, promptIdx);
            this.buffer = '';
            const resolve = this.resolveReady;
            this.resolveReady = null;
            this.rejectReady = null;
            resolve(output);
        }
    }

    kill() {
        this.cleanResultFile();
        this.resolveReady = null;
        this.rejectReady = null;
        if (this.proc) {
            this.proc.removeAllListeners();
            this.proc.stdout?.removeAllListeners();
            this.proc.stderr?.removeAllListeners();
            this.proc.kill();
            this.proc = null;
            this._ready = false;
        }
    }
}

function parseResults(output: string): SearchResult[] {
    const results: SearchResult[] = [];
    const lines = output.split('\n');

    let currentName = '';
    let currentType = '';

    for (const line of lines) {
        if (/^\s*$/.test(line)) { continue; }
        if (/^File |^\[|^Warning|^\(use "About"/.test(line)) { continue; }
        if (/^with arguments|^One of them/.test(line)) { continue; }

        const match = line.match(/^(\S+)\s*:\s*(.*)/);
        if (match) {
            if (currentName) {
                results.push({ name: currentName, type: currentType.trim() });
            }
            currentName = match[1];
            currentType = match[2];
        } else if (currentName) {
            currentType += ' ' + line.trim();
        }
    }

    if (currentName) {
        results.push({ name: currentName, type: currentType.trim() });
    }

    return results;
}
