import { renderPath } from "../test/support";

const path = process.argv[2];
if (path === undefined) throw new Error("Pass the URL path to server-render");
process.stdout.write(JSON.stringify(await renderPath(path)));
