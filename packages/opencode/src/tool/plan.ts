import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider"
import { Instance } from "../project/instance"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { type SessionID, MessageID, PartID } from "../session/schema"
import ENTER_DESCRIPTION from "./plan-enter.txt"
import EXIT_DESCRIPTION from "./plan-exit.txt"

function getLastModel(sessionID: SessionID) {
  for (const item of MessageV2.stream(sessionID, { agentID: "*" })) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return undefined
}

export const PlanEnterTool = Tool.define(
  "plan_enter",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: ENTER_DESCRIPTION,
      parameters: z.object({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                key: "plan_enter",
                params: {},
                question: "Would you like to switch to the plan agent to create a plan before implementing?",
                header: "Plan",
                options: [
                  { label: "Yes", description: "Switch to plan agent to research and design first" },
                  { label: "No", description: "Continue with direct implementation" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const answer = answers[0]?.[0]
          if (answer === "No") return yield* new Question.RejectedError()

          return {
            title: "Switching to plan agent",
            output: "User approved switching to plan agent.",
            metadata: { switched: true },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const fsys = yield* AppFileSystem.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: z.object({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* session.get(ctx.sessionID)
          const planPath = Session.plan(info)
          const plan = path.relative(Instance.worktree, planPath)

          // Read plan content so we can include it in the build agent context
          let planContent: string | undefined
          if (yield* fsys.existsSafe(planPath)) {
            planContent = yield* fsys.readFileString(planPath)
          }

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                key: "plan_exit",
                params: { plan },
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Plan",
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const answer = answers[0]?.[0]
          if (answer === "No") return yield* new Question.RejectedError()

          if (answer !== "Yes") {
            return {
              title: "User provided feedback",
              output: `User chose not to switch yet and provided feedback: ${answer}`,
              metadata: { switched: false, feedback: answer },
            }
          }

          const model = getLastModel(ctx.sessionID) ?? (yield* provider.defaultModel())

          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)

          // Include the plan content in the build agent's context so it
          // knows exactly what to implement without needing to re-read
          // the plan file (#512).
          const planText = planContent
            ? `The plan at ${plan} has been approved, you can now edit files. Execute the plan:\n\n${planContent}`
            : `The plan at ${plan} has been approved, you can now edit files. Execute the plan`

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: planText,
            synthetic: true,
          } satisfies MessageV2.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: { switched: true, feedback: "" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
