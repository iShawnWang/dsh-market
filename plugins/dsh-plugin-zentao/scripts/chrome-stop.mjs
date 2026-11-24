/** Stop the shared headless Chrome started by `scripts/cdp.mjs`. */
import { spawn } from 'node:child_process';

const PORT = Number(process.env.ZT_CDP_PORT ?? 9601);
spawn('pkill', ['-f', `remote-debugging-port=${PORT}`], { stdio: 'inherit' });
