const { currentUser, db, fail, response } = require("./_shared.cjs");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return response(405, { error: "Method not allowed." }, { Allow: "GET" });
    return response(200, { user: await currentUser(event, db()) });
  } catch (error) { return fail(error); }
};