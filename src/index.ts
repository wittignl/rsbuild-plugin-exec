import { type ChildProcess, spawn } from 'node:child_process';
import { type RsbuildPlugin, type Rspack, logger } from '@rsbuild/core';


const RELEVANT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'] as const;

type ArrayElement<ArrayType extends readonly unknown[]> =
  ArrayType extends readonly (infer ElementType)[] ? ElementType : never;

interface ExecCommandOptionsGeneratorOptions {

    stats?: Rspack.Stats;
    isFirstCompile: boolean;
    isWatch: boolean;
}

interface ExecCommandOptions {

    command: string;
    args?: string[];
    name?: string;
    env?: Record<string, string>;

    restartDelay?: number;

    onlyOnFirstCompile?: boolean;
    onlyOnWatch?: boolean;
}

interface ExecPluginOptions {

    startDelay?: number;

    default?: (options: ExecCommandOptionsGeneratorOptions) => ExecCommandOptions;
    environments?: Record<string, (options: ExecCommandOptionsGeneratorOptions) => ExecCommandOptions>;
}

interface ExecPluginState {

    subprocesses: Map<string, Map<string, ChildProcess>>;
    shutdownInProgress: boolean;

    signalListeners: Map<ArrayElement<typeof RELEVANT_SIGNALS>, () => Promise<void>>;
    signalCleanup: (() => void) | null;
}

declare global {
    var rsbuildExecPluginState: ExecPluginState | undefined;
}

/**
 * Represents the global state for the exec plugin.
 * This object is attached to globalThis to persist state across module loads.
 * @property {Map<string, Map<string, ChildProcess>>} subprocesses - A nested map of running subprocesses, organized by project ID and command ID
 * @property {boolean} shutdownInProgress - Flag indicating whether a shutdown is currently in progress
 * @property {Function|null} signalCleanup - Optional callback for cleanup operations during shutdown
 */
const globalPluginState: ExecPluginState = globalThis.rsbuildExecPluginState || {

    subprocesses: new Map<string, Map<string, ChildProcess>>(),
    shutdownInProgress: false,

    signalCleanup: null,
    signalListeners: new Map<NodeJS.Signals, () => Promise<void>>()
};

/**
 * Pauses the execution of an async function for a specified time.
 *
 * @param ms - The number of milliseconds to sleep
 * @returns A Promise that resolves after the specified time has elapsed
 * @remarks When ms is 0 or negative, the function returns immediately without using setTimeout
 * @example
 * ```typescript
 * // Sleep for 1 second
 * await sleep(1000);
 * ```
 */
async function sleep(ms: number): Promise<void> {

    // When ms is 0, avoid the overhead of setTimeout
    if (ms <= 0) {
        return;
    }

    return await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kills all tracked subprocesses for the specified environment or all environments.
 *
 * This function first sends a SIGTERM signal to each subprocess. If a subprocess
 * doesn't exit within 2000ms, it forcefully terminates it with SIGKILL.
 *
 * @param environment - Optional environment name to target specific subprocesses.
 *                      If not provided, subprocesses from all environments will be killed.
 * @returns A promise that resolves when all subprocesses have been terminated
 */
async function killSubprocesses(environment?: string): Promise<void> {

    const subprocesses = globalPluginState.subprocesses;
    const envs = environment ? [environment] : Array.from(subprocesses.keys());

    await Promise.all(
        envs.flatMap(async (env): Promise<void> => {

            const envSubProcesses = subprocesses.get(env);
            if (!envSubProcesses) {
                return;
            }

            const killPromises = Array.from(envSubProcesses.entries())
                .map(async ([_, subProcess]): Promise<void> => {

                    return new Promise<void>((resolve) => {

                        const timeoutId = setTimeout(
                            (): void => {
                                subProcess.kill('SIGKILL');
                                resolve();
                            },
                            2000
                        );

                        subProcess.once('exit', () => {
                            clearTimeout(timeoutId);
                            resolve();
                        });

                        subProcess.once('error', () => {
                            clearTimeout(timeoutId);
                            resolve();
                        });

                        subProcess.kill('SIGTERM');
                    });
                });

            await Promise.all(killPromises);
            envSubProcesses.clear();
        })
    );
}

/**
 * Sets up signal handlers to manage subprocess cleanup on process termination.
 *
 * This function registers listeners for relevant signals (like SIGTERM, SIGINT, etc.)
 * that will properly terminate any child processes before the main process exits.
 *
 * The function is designed to be idempotent - it will only set up handlers once.
 * If handlers are already set up (indicated by `globalPluginState.signalCleanup` being non-null),
 * the function will return early.
 *
 * When a termination signal is received, the function:
 * 1. Kills all subprocesses via the `killSubprocesses()` function
 * 2. Exits the process with code 0
 *
 * Also sets up a cleanup function in `globalPluginState.signalCleanup` that removes
 * all registered signal handlers when called.
 */
function setupSignalHandlers(): void {

    if (globalPluginState.signalCleanup != null) {
        return;
    }

    for (const signal of RELEVANT_SIGNALS) {

        const listener = async (): Promise<void> => {

            // Prevents calling 'killSubprocesses' multiple times.
            if (globalPluginState.shutdownInProgress) {
                return;
            }

            globalPluginState.shutdownInProgress = true;

            try {

                await killSubprocesses();
            }
            finally {

                globalPluginState.shutdownInProgress = false;
            }
        };

        process.on(signal, listener);
        globalPluginState.signalListeners.set(signal, listener);
    }

    globalPluginState.signalCleanup = (): void => {

        for (const signal of RELEVANT_SIGNALS) {

            const listener = globalPluginState.signalListeners.get(signal);
            if (listener == null) {
                continue;
            }

            process.off(signal, listener);
        }

        globalPluginState.signalCleanup = null;
    };
}

/**
 * Creates an Rsbuild plugin that executes commands when compilation completes.
 *
 * This plugin runs specified commands after successful compilation in watch mode.
 * It manages subprocess lifecycle, including starting, killing, and handling output.
 *
 * @param options - Configuration options for the exec plugin
 * @param options.startDelay - Milliseconds to wait after compilation before starting subprocesses
 * @param options.default - Default command options to use if environment-specific options aren't provided
 * @param options.environments - Environment-specific command options keyed by environment name (Corresponds to those defined in the RSBuild config)
 *
 * @returns An Rsbuild plugin that manages subprocess execution
 *
 * @example
 * ```ts
 * // Basic usage with default command for all environments
 * pluginExec({
 *   default: () => ({
 *     command: 'node',
 *     args: ['./dist/server.js']
 *   })
 * })
 *
 * // Environment-specific commands with custom options
 * pluginExec({
 *   environments: {
 *     development: () => ({
 *       command: 'node',
 *       args: ['--inspect', './dist/server.js'],
 *       env: { DEBUG: 'app:*' }, // NODE_ENV and RSBUILD_ENV are set automatically (optional)
 *       restartDelay: 1000 // Delay before restarting the subprocess after killing the previous one (optional)
 *     })
 *   }
 * })
 * ```
 */
export function pluginExec(options: ExecPluginOptions): RsbuildPlugin {

    return {
        name: 'exec',
        setup(api): void {

            setupSignalHandlers();

            api.onBeforeCreateCompiler(
                async (): Promise<void> => {
                    await killSubprocesses();
                }
            );

            const compilationTimers = new Map<string, NodeJS.Timeout>();

            api.onAfterEnvironmentCompile(
                async ({ stats, isFirstCompile, isWatch, environment }) => {

                    if (globalPluginState.shutdownInProgress) {
                        return;
                    }

                    const envName: string = environment.name;

                    if (stats?.hasErrors()) {
                        logger.warn(`Compilation errors in ${envName}, skipping subprocess start for this environment.`);
                        return;
                    }

                    const commandOptions = (
                        options.environments?.[envName]?.({ stats, isFirstCompile, isWatch })
                        || options.default?.({ stats, isFirstCompile, isWatch })
                    );

                    if (commandOptions?.onlyOnFirstCompile && !isFirstCompile) {
                        return;
                    }

                    if (commandOptions?.onlyOnWatch && !isWatch) {
                        return;
                    }

                    const existingTimer = compilationTimers.get(envName);
                    if (existingTimer) {
                        clearTimeout(existingTimer);
                    }

                    compilationTimers.set(
                        envName,
                        setTimeout(
                            async (): Promise<void> => {

                                compilationTimers.delete(envName);

                                if (!commandOptions) {
                                    return;
                                }

                                const {
                                    command,
                                    args = [],
                                    name = command,
                                    env = {},
                                    restartDelay = 0
                                } = commandOptions;

                                await killSubprocesses(envName);
                                await sleep(restartDelay);

                                const subprocesses = globalPluginState.subprocesses;
                                if (!subprocesses.has(envName)) {
                                    subprocesses.set(envName, new Map());
                                }

                                const processes = subprocesses.get(envName);
                                if (!processes) {
                                    return; // Gracefully handle edge-case
                                }

                                const processName = `${envName}:${name}`;

                                logger.log(`[${new Date().toISOString()}] Starting subprocess: ${processName}`);

                                const subprocess = spawn(command, args, {
                                    stdio: ['inherit', 'pipe', 'pipe'],
                                    env: {
                                        ...process.env,
                                        NODE_ENV: api.context.bundlerType,
                                        RSBUILD_ENV: envName,
                                        ...env
                                    },
                                    detached: false
                                });

                                processes.set(processName, subprocess);

                                const handleProcessError = (error: Error & { code?: string }): void => {
                                    logger.error(`[${new Date().toISOString()}] Error in subprocess "${processName}":`, error);
                                };

                                subprocess.on('error', handleProcessError);

                                // Buffer stdout and stderr.
                                let stdoutBuffer: string[] = [];
                                subprocess.stdout?.on('data', (chunk: Buffer) => {

                                    stdoutBuffer.push(chunk.toString());

                                    if (!subprocess.killed && process.stdout.writable) {

                                        process.stdout.write(stdoutBuffer.join());
                                        stdoutBuffer = [];
                                    }
                                });

                                let stderrBuffer: string[] = [];
                                subprocess.stderr?.on('data', (chunk: Buffer) => {

                                    stderrBuffer.push(chunk.toString());

                                    if (!subprocess.killed && process.stderr.writable) {

                                        process.stderr.write(stderrBuffer.toString());
                                        stderrBuffer = [];
                                    }
                                });

                                subprocess.stdout?.on('error', handleProcessError);
                                subprocess.stderr?.on('error', handleProcessError);

                                subprocess.on('exit', (code, signal): void => {

                                    if (code !== 0 && code !== null) {

                                        logger.warn(
                                            `[${new Date().toISOString()}] Exec "${processName}" exited with code ${code}.`
                                        );
                                    }
                                    else if (signal) {

                                        logger.warn(
                                            `[${new Date().toISOString()}] Exec "${processName}" killed with signal ${signal}.`
                                        );
                                    }

                                    processes.delete(processName);
                                });
                            },
                            options.startDelay ?? 0
                        )
                    );
                }
            );
        }
    };
}
