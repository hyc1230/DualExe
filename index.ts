import * as cp from "child_process";
import * as fs from "fs";
import * as readline from "readline";
import * as it from "io-ts";
import { PathReporter } from "io-ts/lib/PathReporter";
import { isLeft } from "fp-ts/lib/Either";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ""
});

const sgr_regex = /\x1b\[[0-9;]*m/g;
const sgr_reset = "\x1b[0m";
const sgr_good = "\x1b[32m";
const sgr_bad = "\x1b[31m";
const sgr_stress = "\x1b[33m";
const sgr_notice = "\x1b[34m";

let current_input = "";

function erase_input(): void {
    if (process.platform === "win32") {
        process.stdout.write("\x1b[2K\r");
    } else {
        process.stdout.write("\x1b[1K\r");
    }
}
function restore_input(): void {
    process.stdout.write(current_input);
}
function print_info(...content: any[]): void {
    erase_input();
    console.log("[DUALEXE][INFO]", ...content, sgr_reset);
    restore_input();
}
function print_error(...content: any[]): void {
    erase_input();
    console.error(`[DUALEXE][ERROR]${sgr_bad}`, ...content, sgr_reset);
    restore_input();
}
function print_stdout(label: string, content: string, sgr: string): void {
    erase_input();
    console.log(`[${label}][STDOUT]${sgr}`, content, sgr_reset);
    restore_input();
}
function print_stderr(label: string, content: string, sgr: string): void {
    erase_input();
    console.error(`[${label}][STDERR]${sgr}`, content, sgr_reset);
    restore_input();
}

const SingleConfig = it.type({
    cwd: it.string,
    command: it.string,
    stop_command: it.string,
    auto_restart: it.boolean,
    ignore_stdout: it.boolean || it.undefined,
    ignore_stderr: it.boolean || it.undefined,
});
const Config = it.record(it.string, SingleConfig);
let cfgtemp;
try {
    cfgtemp = JSON.parse(fs.readFileSync("dualexe.config.json").toString());
    const chkres = Config.decode(cfgtemp);
    if (isLeft(chkres)) {
        throw new Error(PathReporter.report(chkres).join("\n"));
    }
} catch (err) {
    print_error("Failed to read or parse config");
    print_error(err);
    process.exit(1);
}

interface SingleConfigInterface {
    cwd: string,
    command: string,
    stop_command: string,
    auto_restart: boolean,
    ignore_stdout?: boolean,
    ignore_stderr?: boolean,
};
const config: {[key: string]: SingleConfigInterface} = cfgtemp;

function get_sgr(data: string): string {
    const matches = data.match(sgr_regex);
    if (!matches) {
        return "";
    }
    const last_reset = matches.lastIndexOf(sgr_reset);
    return last_reset === -1 ? "" : matches.slice(last_reset + 1).join("");
}

const status: {[key: string]: boolean} = {};
const input_handlers: {[key: string]: (data: string) => void} = {};
const stop_handlers: {[key: string]: (force?: boolean) => void} = {};
const asked_to_stop: {[key: string]: boolean} = {};

const promises: Promise<number>[] = [];
var pendingPromises: number = 0;

function run_script(
    label: string,
    script_config: SingleConfigInterface
    // cwd: string,
    // command: string,
    // stop_command: string,
    // auto_restart: boolean,
    // ignore_stdout?: boolean,
    // ignore_stderr?: boolean
): Promise<number> {
    return new Promise((resolve, reject) => {
        const cwd = script_config.cwd;
        const command = script_config.command;
        const stop_command = script_config.stop_command;
        const auto_restart = script_config.auto_restart;
        const ignore_stdout = script_config.ignore_stdout || false;
        const ignore_stderr = script_config.ignore_stderr || false;
        print_info(`Starting: ${label}${
            ignore_stdout || ignore_stderr
            ?
                ` ${sgr_notice}w/ silent ` + 
                (ignore_stdout
                ? "stdout"
                : "") + 
                (ignore_stdout && ignore_stderr
                ? "&"
                : "") +
                (ignore_stderr
                ? "stderr"
                : "")
            : ""
        }`);

        status[label] = true;
        const proc = cp.spawn(command, { cwd: cwd, shell: true });
        let stdout_buf: string = "", stderr_buf: string = "";
        let stdout_sgr: string = "", stderr_sgr: string = "";
        
        if (!ignore_stdout) {
            proc.stdout.on("data", (data) => {
                stdout_buf += data.toString();
                let lines = stdout_buf.split("\n");
                stdout_buf = lines.pop() || "";
                for (const l of lines) {
                    print_stdout(label, l, stdout_sgr);
                    stdout_sgr = get_sgr(stdout_sgr + l);
                }
            });
        }
        if (!ignore_stderr) {
            proc.stderr.on("data", (data) => {
                stderr_buf += data.toString();
                let lines = stderr_buf.split("\n");
                stderr_buf = lines.pop() || "";
                for (const l of lines) {
                    print_stderr(label, l, stderr_sgr);
                    stderr_sgr = get_sgr(stderr_sgr + l);
                }
            });
        }
        input_handlers[label] = (data: string): void => {
            proc.stdin.write(data);
        };
        stop_handlers[label] = (force: boolean = false): void => {
            if (force) {
                if (proc.kill("SIGTERM")) {
                    print_info(`Sent SIGTERM to process: ${label}`);
                } else if (proc.kill("SIGKILL")) {
                    print_info(`Sent SIGKILL to process: ${label}`);
                } else {
                    print_info(`Failed to kill process: ${label}`);
                }
            } else {
                proc.stdin.write(`${stop_command}\n`);
                print_info(`Sent stop command to process: ${label}`);
            }
        };
    
        proc.on("close", (code) => {
            status[label] = false;
            delete input_handlers[label];
            delete stop_handlers[label];
            if (stdout_buf) {
                print_stdout(label, stdout_buf, stdout_sgr);
            }
            if (stderr_buf) {
                print_stderr(label, stderr_buf, stderr_sgr);
            }
            print_info(`Exit: ${label} / code ${code}`);
            if (auto_restart && !asked_to_stop[label]) {
                run_script(label, script_config).then((code: number) => {
                    resolve(code);
                });
            } else {
                resolve(code || 0);
                pendingPromises--;
            }
        });
        
    });
}

async function handle_input(line: string): Promise<void> {
    const supported_commands = ["exit", "killall", "start", "input", "stop", "kill", "restart", "status"];
    const args = line.trim().split(" ");
    if (args[0] === "exit" || args[0] === "killall" || (args.length === 1 && args[0] === "stop")) {
        for (const label in status) {
            if (status[label]) {
                asked_to_stop[label] = true;
                stop_handlers[label](args[0] === "killall");
            }
        }
    } else if (args[0] === "status") {
        for (const label in status) {
            print_info(`${label}: ${status[label]
                ?
                    asked_to_stop[label]
                    ?
                        `${sgr_stress}Stopping`
                    :
                        `${sgr_good}Running`
                :
                    `${sgr_bad}Stopped`
            }`);
        }
    } else if (args[0] === "start") {
        if (status[args[1]]) {
            print_error(`Already running: ${args[1]}`);
        } else if (!config[args[1]]) {
            print_error(`Undefined: ${args[1]}`);
        } else {
            asked_to_stop[args[1]] = false;
            promises.push(run_script(args[1], config[args[1]]));
            pendingPromises++;
        }
    } else if (status[args[1]]) {
        if (args[0] === "input") {
            const label = args[1];
            if (input_handlers[label] !== undefined) {
                input_handlers[label](line.split(" ").slice(2).join(" ") + "\n");
            }
        } else if (args[0] === "stop" || args[0] === "kill") {
            asked_to_stop[args[1]] = true;
            stop_handlers[args[1]](args[0] === "kill");
        } else if (args[0] === "restart") {
            stop_handlers[args[1]]();
        } else {
            print_error("Unknown command");
        }
    } else {
        if (supported_commands.findIndex((value, index, obj) => {
            return value === args[0];
        }) !== -1) {
            print_error(`Undefined or not running: (arg1)${args[1]}`);
        } else {
            print_error(`Unknown command: (arg0)${args[0]}`);
        }
    }
}

process.stdin.on("keypress", (str, key) => {
    if (key.ctrl && key.name === "c") {
        process.exit();
    } else if (key.name === "backspace") {
        current_input = current_input.slice(0, -1);
        erase_input();
        restore_input();
    } else if (key.name === "return" || key.name === "enter") {
        let temp = current_input;
        current_input = "";
        handle_input(temp).catch((err) => {
            print_error(err);
        });
    } else if (typeof(str) === "string") {
        current_input += str;
    }
    // print_info(`${key.name} / ${str} ; ${typeof str} / ${current_input}`);
});

for (const label in config) {
    promises.push(run_script(label, config[label]));
}
pendingPromises = promises.length;

async function waitAlive(): Promise<void> {
    await Promise.all(promises);
    if (pendingPromises) {
        await waitAlive();
    }
}

waitAlive().then(() => {
    print_info(`All processes exited`);
    process.exit(0);
});
