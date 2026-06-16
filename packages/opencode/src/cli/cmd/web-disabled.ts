import { cmd } from "./cmd"
import { UI } from "../ui"

export const WebDisabledCommand = cmd({
  command: "web",
  describe: "start mimocode server and open web interface (temporarily disabled)",
  builder: (yargs) => yargs,
  handler: async () => {
    UI.println(UI.Style.TEXT_WARNING_BOLD + "  The 'mimo web' command is temporarily disabled.")
    UI.println("")
    UI.println("  You can use 'mimo serve' instead to start the web server,")
    UI.println("  then open the URL displayed in your browser.")
  },
})