import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { writeFileSync as write } from "node:fs"

const T=new Set(["message","tool_result","thinking_level_change","model_change"])

export default function(pi:ExtensionAPI){pi.registerCommand("clear",{description:"Clear all messages from the current session",handler:async(a,c)=>{if(!c.isIdle())await c.waitForIdle()
const m=c.sessionManager.getEntries().filter(e=>T.has(e.type));if(!m.length)return c.ui.notify("Session is already empty","info")
if(!a.includes("--force")&&!(await c.ui.confirm("Clear session?",`Delete ${m.length} message(s) from the current session?\n\nThis cannot be undone. Use /tree to browse history if you want to recover a previous state.`))){c.ui.notify("Clear cancelled","info");return}
const h=c.sessionManager.getHeader(),f=c.sessionManager.getSessionFile();if(!h||!f)return c.ui.notify(`Error: ${h?"No session file found":"Could not find session header"}`,"error")
write(f,`${JSON.stringify(h)}\n`);c.sessionManager.setSessionFile(f);await c.reload();c.ui.notify("Session cleared","success")}})}
