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

const reset_code = "\x1b[0m";
const sgr_regex = /\x1b\[[0-9;]*m/g;

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
    console.log(`${reset_code}[DUALEXE][INFO]`, ...content);
    restore_input();
}
function print_error(...content: any[]): void {
    erase_input();
    console.error(`${reset_code}[DUALEXE][ERROR]`, ...content);
    restore_input();
}
function print_stdout(label: string, content: string, sgr: string): void {
    erase_input();
    console.log(`${reset_code}[${label}][STDOUT]${sgr}`, content);
    restore_input();
}
function print_stderr(label: string, content: string, sgr: string): void {
    erase_input();
    console.error(`${reset_code}[${label}][STDERR]${sgr}`, content);
    restore_input();
}

const SingleConfig = it.type({
    cwd: it.string,
    command: it.string,
    stop_command: it.string,
    auto_restart: it.boolean
});
const Config = it.record(it.string, SingleConfig);
let cfgtemp;
try {
    cfgtemp = JSON.parse(fs.readFileSync("config.json").toString());
    const chkres = Config.decode(cfgtemp);
    if (isLeft(chkres)) {
        throw new Error(PathReporter.report(chkres).join("\n"));
    }
} catch (err) {
    print_error("Failed to read or parse config");
    print_error(err);
    process.exit(1);
}

const config = cfgtemp;

function get_sgr(data: string): string {
    const matches = data.match(sgr_regex);
    if (!matches) {
        return "";
    }
    const last_reset = matches.lastIndexOf(reset_code);
    return last_reset === -1 ? "" : matches.slice(last_reset + 1).join("");
}

const status: {[key: string]: boolean} = {};
const input_handlers: {[key: string]: (data: string) => void} = {};
const stop_handlers: {[key: string]: (force?: boolean) => void} = {};
const asked_to_stop: {[key: string]: boolean} = {};

const promises: Promise<number>[] = [];

function run_script(label: string, cwd: string, command: string, stop_command: string, auto_restart: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
        print_info(`Starting: ${label}`);

        status[label] = true;
        const proc = cp.spawn(command, { cwd: cwd, shell: true });
        let stdout_buf: string = "", stderr_buf: string = "";
        let stdout_sgr: string = "", stderr_sgr: string = "";
        
        proc.stdout.on("data", (data) => {
            stdout_buf += data.toString();
            let lines = stdout_buf.split("\n");
            stdout_buf = lines.pop() || "";
            for (const l of lines) {
                print_stdout(label, l, stdout_sgr);
                stdout_sgr = get_sgr(stdout_sgr + l);
            }
        });
        proc.stderr.on("data", (data) => {
            stderr_buf += data.toString();
            let lines = stderr_buf.split("\n");
            stderr_buf = lines.pop() || "";
            for (const l of lines) {
                print_stderr(label, l, stderr_sgr);
                stderr_sgr = get_sgr(stderr_sgr + l);
            }
        });
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
                run_script(label, cwd, command, stop_command, auto_restart).then((code: number) => {
                    resolve(code);
                });
            } else {
                resolve(code || 0);
            }
        });
        
    });
}

async function handle_input(line: string): Promise<void> {
    const supported_commands = ["exit", "killall", "start", "input", "stop", "kill", "restart"];
    const args = line.split(" ");
    if (args[0] === "exit" || args[0] === "killall") {
        for (const label in status) {
            if (status[label]) {
                asked_to_stop[label] = true;
                stop_handlers[label](args[0] === "killall");
            }
        }
    } else if (args[0] === "start") {
        if (status[args[1]]) {
            print_info(`Already running: ${args[1]}`);
        } else if (!config[args[1]]) {
            print_info(`Undefined: ${args[1]}`);
        } else {
            asked_to_stop[args[1]] = false;
            promises.push(run_script(args[1], config[args[1]].cwd, config[args[1]].command, config[args[1]].stop_command, config[args[1]].auto_restart));
        }
    } else if (status[args[1]]) {
        if (args[0] === "input") {
            const label = args[1];
            if (input_handlers[label] !== undefined) {
                input_handlers[label](line.split(" ").slice(2).join(" "));
            }
        } else if (args[0] === "stop" || args[0] === "kill") {
            asked_to_stop[args[1]] = true;
            stop_handlers[args[1]](args[0] === "kill");
        } else if (args[0] === "restart") {
            stop_handlers[args[1]]();
        } else {
            print_info("Unknown command");
        }
    } else {
        if (supported_commands.findIndex((value, index, obj) => {
            return value === args[0];
        }) !== -1) {
            print_info(`Undefined: ${args[1]}`);
        } else {
            print_info("Unknown command");
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
    promises.push(run_script(label, config[label].cwd, config[label].command, config[label].stop_command, config[label].auto_restart));
}
Promise.all(promises).then(() => {
    print_info(`All processes exited`);
    process.exit(0);
});
