import * as core from "@actions/core";
import * as io from "@actions/io";
import { getExecOutput as $ } from "@actions/exec";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function base64Encode(str: string) {
    return Buffer.from(str).toString('base64');
}

let CWD = process.cwd();

class Token {
    private _originalConfig: string | null;

    constructor() {
        const s = spawnSync('git', ['config', '--global', 'http.https://github.com/.extraHeader']);
        this._originalConfig = s.error ? null : s.stdout.toString().trim();
    }

    set(token: string) {
        core.debug('setting token');
        const header = `AUTHORIZATION: basic ${base64Encode(`x-access-token:${token}`)}`
        const result = spawnSync('git', ['config', '--global', 'http.https://github.com/.extraHeader', header]);
        if (result.error) {
            throw result.error;
        }
    }

    restore() {
        core.debug('restoring token');
        let err: Error | undefined;
        if (this._originalConfig === null) {
            err = spawnSync('git', ['config', '--global', '--unset', 'http.https://github.com/.extraHeader']).error;
        } else {
            err = spawnSync('git', ['config', '--global', 'http.https://github.com/.extraHeader', this._originalConfig]).error;
        }
        if (err) throw err;
    }

}

interface User {
    name: string | null
    email: string | null
}

function parseUser(s: string | null): User {
    if (typeof s !== 'string') return { name: null, email: null };
    const str = s.trim();
    const expr = /^(.+)\s+<(.+@.+)>$/;
    const match = str.match(expr);
    if (match) {
        return {
            name: match[1],
            email: match[2]
        };
    }
    if (str.includes('@')) {
        return {
            name: null,
            email: str
        };
    }
    return {
        name: str,
        email: null
    };
}

interface InputObject {
    repo_url: string;
    branch: string | null;
    user: User;
    clone_dest: string;
    token: string | null;
    depth: number | null;
    cwd: string | null;
    auto_create_cwd: boolean;
}

function collectInput() {
    const o: InputObject = {} as InputObject;
    o.repo_url = core.getInput('repository');
    if (/^[^\s\/]+\/[^\s\/]+$/.test(o.repo_url)) {
        o.repo_url = `https://github.com/${o.repo_url}`;
    }
    o.branch = core.getInput('branch') || null;
    o.user = parseUser(core.getInput('set-user') || null);
    o.clone_dest = core.getInput('path');
    o.token = core.getInput('token') || null;
    // fetch-depth
    const depth = core.getInput('fetch-depth')
    if (depth === '') o.depth = null;
    else o.depth = Number.parseInt(depth);
    if (typeof o.depth !== 'number' || Number.isNaN(o.depth)) {
        throw new Error('depth must be a number');
    }
    if (o.depth < 0) o.depth = null;
    // cwd
    o.cwd = core.getInput('cwd') || null;
    if (o.cwd) {
        o.cwd = path.resolve(CWD, o.cwd);
        core.debug(`cwd: ${o.cwd}`);
        CWD = o.cwd;
    }
    // auto-create-cwd
    const auto_create_cwd = core.getInput('auto-create-cwd');
    if (auto_create_cwd === 'true') {
        o.auto_create_cwd = true;
    } else if (auto_create_cwd === 'false') {
        o.auto_create_cwd = false;
    } else {
        throw new Error('auto-create-cwd must be a boolean');
    }
    return o;
}

interface RepoObject {
    name: string;
    path: string;
}

async function clone_repo(repo_url: string, branch: string | null, depth: number | null, dest?: string) {
    const args = ['clone']
    if (depth) args.push('--depth', depth.toString());
    if (branch) args.push('--branch', branch);
    args.push(repo_url);
    const o: RepoObject = {} as RepoObject;
    async function createDirFor(dest: string) {
        const father = path.dirname(dest);
        if (!fs.existsSync(father)) {
            core.debug(`[clone] creating directory ${father} for ${dest}`);
            await io.mkdirP(father);
        }
    }
    if (dest) {
        core.debug(`cloninng ${repo_url} to ${dest}`);
        const repository_path = path.resolve(CWD, dest);
        await createDirFor(repository_path);
        // clone
        const exitCode = (await $('git', args.concat(repository_path), { cwd: CWD })).exitCode;
        if (exitCode !== 0) {
            throw new Error('git clone failed');
        }
        o.name = path.basename(repository_path);
        o.path = repository_path;
        core.setOutput('repository_name', path.basename(repository_path));
    } else {
        // auto infer destination name, move to temporary directory first
        core.debug(`cloninng ${repo_url} (auto detect destination name)`);
        const temp_dir = fs.mkdtempSync('clone-');
        core.debug(`[clone] temp_dir: ${temp_dir}`);
        // clone
        const exitCode = (await $('git', args, { cwd: temp_dir })).exitCode;
        if (exitCode !== 0) {
            throw new Error('git clone failed');
        }
        const dir = await fs.promises.readdir(temp_dir);
        core.debug(`[clone] things in temp_dir: ${dir}`);
        if (dir.length === 0) {
            throw new Error('git clone failed');
        }
        const repository_name = dir[0];
        const repository_path = path.resolve(CWD, repository_name);
        await createDirFor(repository_path);
        // start move
        core.debug(`[clone] moving ${path.join(temp_dir, repository_name)} to ${repository_path}`);
        await io.mv(path.join(temp_dir, repository_name), repository_path);
        core.debug(`[clone] removing temp_dir: ${temp_dir}`);
        await io.rmRF(temp_dir);
        o.name = repository_name;
        o.path = repository_path;
    }
    core.setOutput('repository_path', o.path);
    core.setOutput('repository_name', o.name);
    core.debug(`repository_path: ${o.path}`);
    core.debug(`repository_name: ${o.name}`);
    return o;
}

async function main() {
    const o = collectInput();
    if (o.auto_create_cwd && o.cwd) {
        if (!fs.existsSync(o.cwd)) {
            core.debug(`creating cwd: ${o.cwd}`);
            await io.mkdirP(o.cwd);
        }
    }
    if (o.cwd) {
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        process.env['GITHUB_WORKSPACE'] = o.cwd;
    }

    core.debug(`user: ${JSON.stringify(o.user)}`);
    if (o.user.name) await $('git', ['config', '--global', 'user.name', o.user.name]);
    if (o.user.email) await $('git', ['config', '--global', 'user.email', o.user.email]);

    const t = new Token();
    if (o.token) t.set(o.token);

    core.startGroup('Clone repository');
    const repo = await clone_repo(o.repo_url, o.branch, o.depth, o.clone_dest);
    core.endGroup();

    if (repo.path) {
        const ref = (await $('git', ['-C', repo.path, 'symbolic-ref', 'HEAD'])).stdout.trim();
        core.setOutput('ref', ref);
        core.debug(`ref: ${ref}`);
        const sha = (await $('git', ['-C', repo.path, 'rev-parse', 'HEAD'])).stdout.trim();
        core.setOutput('sha', sha);
        core.debug(`sha: ${sha}`);
        const branch = (await $('git', ['-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
        core.setOutput('branch', branch);
        core.debug(`branch: ${branch}`);
    }

    t.restore();
}

const ispost = !!core.getState('isPost');
core.debug(`isPost: ${ispost}`);

if (!ispost) {
    main().catch(e => {
        core.setFailed(e.message);
    })
}