import * as cp from "child_process";
import * as fs from "fs";
import * as readline from "readline";

const config = JSON.parse(fs.readFileSync("config.json").toString());

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
function print_info(content: string): void {
    erase_input();
    console.log(`${reset_code}[DUALEXE] ${content}`);
    restore_input();
}
function print_stdout(label: string, content: string, sgr: string): void {
    erase_input();
    console.log(`${reset_code}[${label}][STDOUT] ${sgr}${content}`);
    restore_input();
}
function print_stderr(label: string, content: string, sgr: string): void {
    erase_input();
    console.error(`${reset_code}[${label}][STDERR] ${sgr}${content}`);
    restore_input();
}

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
const stop_handlers: {[key: string]: (force: boolean) => void} = {};
const asked_to_stop: {[key: string]: boolean} = {};

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
        stop_handlers[label] = (force: boolean): void => {
            if (force) {
                proc.kill();
            } else {
                proc.stdin.write(`${stop_command}\n`);
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

const promises: Promise<number>[] = [];

async function handle_input(line: string): Promise<void> {
    const args = line.split(" ");
    if (args.length >= 2) {
        if (args[0] === "start") {
            if (status[args[1]]) {
                print_info(`Already running: ${args[1]}`);
            } else if (!config[args[1]]) {
                print_info(`Undefined: ${args[1]}`);
            } else {
                promises.push(run_script(args[1], config[args[1]].cwd, config[args[1]].command, config[args[1]].stop_command, config[args[1]].auto_restart));
            }
        } else if (status[args[1]]) {
            if (args[0] === "input") {
                const label = args[1];
                if (label in input_handlers) {
                    input_handlers[label](line.split(" ").slice(2).join(" "));
                }
            } else if (args[0] === "stop" || args[0] === "kill") {
                asked_to_stop[args[1]] = true;
                stop_handlers[args[1]](args[0] === "kill");
            } else {
                print_info("Unknown command");
            }
        } else {
            print_info(`Not running / Undefined: ${args[1]}`);
        }
    } else {
        print_info("At least 2 args are required");
    }
}

process.stdin.on("keypress", (str, key) => {
    if (key.name === "backspace") {
        current_input = current_input.slice(0, -1);
        erase_input();
        restore_input();
    } else if (key.name === "return" || key.name === "enter") {
        let temp = current_input;
        current_input = "";
        handle_input(temp);
    } else if (typeof(str) === "string") {
        current_input += str;
    }
    // print_info(`${key.name} / ${str} ; ${typeof str} / ${current_input}`);
});

for (const label in config) {
    promises.push(run_script(label, config[label].cwd, config[label].command, config[label].stop_command, config[label].auto_restart));
}
Promise.all(promises).then(() => {
    print_info(`All scripts exited`);
    process.exit(0);
});
