import { handleContinuityRequest, type ContinuityEnv } from "../../worker/continuity";

const worker = {
  async fetch(request: Request, env: ContinuityEnv): Promise<Response> {
    return await handleContinuityRequest(request, env)
      ?? Response.json({ error: "Not found." }, { status: 404 });
  },
};

export default worker;
