// Compatibility exports only. Historical paid experiments are excluded from this distribution.
export { validateSchema } from "../src/shared/validate-schema.mjs";
const routeGroups = { CODE_PROJECT: "code_projects", KNOWLEDGE_PROJECT: "knowledge_projects", TOPIC: "topics" };
const knowledgeTypes = ["DECISION", "STATUS", "KNOWLEDGE", "IDEA", "ACTION", "CONSTRAINT", "LESSON"];
const lenses = ["PRODUCT_THINKING", "ENGINEERING_THINKING"];
const confidence = { type: "number", minimum: 0, maximum: 1 };
const objectSchema = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const contextSchema = objectSchema({
  should_persist: { type: "boolean" },
  route_type: { type: "string", enum: [...Object.keys(routeGroups), "PROJECT_CANDIDATE", "NO_KNOWLEDGE"] },
  route_id: { type: ["string", "null"] },
  route_name: { type: ["string", "null"] },
  knowledge_types: { type: "array", items: { type: "string", enum: knowledgeTypes } },
  title: { type: "string" }, distilled_content: { type: "string" }, confidence,
});
export const insightSchema = objectSchema({
  lens: { type: "string", enum: lenses }, topic: { type: "string" },
  title: { type: "string" }, content: { type: "string" }, confidence,
});
