const { assertSameOrigin, createSession, db, fail, passwordHash, readBody, response } = require("./_shared.cjs");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed." }, { Allow: "POST" });
    assertSameOrigin(event);
    const data = readBody(event);
    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    const password = String(data.password || "");
    if (name.length < 2 || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response(400, { error: "Enter a valid name and email address." });
    }
    if (password.length < 10 || password.length > 128) {
      return response(400, { error: "Password must be between 10 and 128 characters." });
    }
    const client = db();
    const { salt, hash } = await passwordHash(password);
    const { data: user, error } = await client.from("users")
      .insert({ name, email, password_salt: salt, password_hash: hash })
      .select("id,name,email").single();
    if (error?.code === "23505") return response(409, { error: "That email is already registered." });
    if (error) throw error;
    const cookie = await createSession(client, user.id);
    return response(201, { user: { name: user.name, email: user.email } }, { "Set-Cookie": cookie });
  } catch (error) { return fail(error); }
};