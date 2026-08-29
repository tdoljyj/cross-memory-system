export default class RawMcpProvider {
  id = () => "clued-isolated-raw";

  async callApi(_prompt, context) {
    const vars = context?.vars ?? {};
    const headers = { "content-type": "application/json" };
    if (vars.authorization) headers.authorization = vars.authorization;
    const response = await fetch(process.env.MCP_ISOLATED_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Number(vars.request_id),
        method: "tools/call",
        params: {
          name: vars.tool_name,
          arguments: JSON.parse(vars.tool_arguments),
        },
      }),
    });
    return {
      output: await response.text(),
      metadata: { observed_http_status: response.status },
    };
  }
}
