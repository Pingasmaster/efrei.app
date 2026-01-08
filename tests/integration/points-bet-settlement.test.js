const test = require("node:test");
const assert = require("node:assert/strict");

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000";
const API_URL = process.env.API_URL || "http://localhost:4000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;

const jsonRequest = async ({ url, method = "GET", token, body, headers = {} }) => {
  const finalHeaders = {
    ...headers
  };
  if (token) {
    finalHeaders.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    payload = { raw: text };
  }
  return { response, payload };
};

const randomEmail = (prefix) => `${prefix}.${Date.now()}@test.local`;

const registerOrLogin = async ({ name, email, password }) => {
  const register = await jsonRequest({
    url: `${GATEWAY_URL}/auth/register`,
    method: "POST",
    body: { name, email, password }
  });
  if (register.response.status === 201) {
    return register.payload;
  }
  if (register.response.status === 409) {
    const login = await jsonRequest({
      url: `${GATEWAY_URL}/auth/login`,
      method: "POST",
      body: { email, password }
    });
    if (!login.payload?.ok) {
      throw new Error(`Login failed for ${email}: ${JSON.stringify(login.payload)}`);
    }
    return login.payload;
  }
  throw new Error(`Register failed for ${email}: ${JSON.stringify(register.payload)}`);
};

let adminSession = null;

test.before(async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error("Set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD to run integration tests.");
  }
  const admin = await registerOrLogin({
    name: "Admin",
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD
  });
  if (!admin?.user?.permissions?.includes("admin.access")) {
    throw new Error("Admin user lacks admin.access permission. Ensure ADMIN_BOOTSTRAP_EMAIL matches TEST_ADMIN_EMAIL.");
  }
  adminSession = admin;
});

test("points credit/debit flow", { timeout: 30000 }, async () => {
  const user = await registerOrLogin({
    name: "Points User",
    email: randomEmail("points"),
    password: "password123"
  });

  const credit = await jsonRequest({
    url: `${API_URL}/admin/users/${user.user.id}/points/credit`,
    method: "POST",
    token: adminSession.token,
    body: { amount: 50 }
  });
  assert.equal(credit.response.status, 200, JSON.stringify(credit.payload));

  const afterCredit = await jsonRequest({
    url: `${API_URL}/users/${user.user.id}`,
    method: "GET",
    token: user.token
  });
  assert.equal(afterCredit.response.status, 200, JSON.stringify(afterCredit.payload));
  assert.equal(afterCredit.payload.user.points, 1050);

  const debit = await jsonRequest({
    url: `${API_URL}/admin/users/${user.user.id}/points/debit`,
    method: "POST",
    token: adminSession.token,
    body: { amount: 20 }
  });
  assert.equal(debit.response.status, 200, JSON.stringify(debit.payload));

  const afterDebit = await jsonRequest({
    url: `${API_URL}/users/${user.user.id}`,
    method: "GET",
    token: user.token
  });
  assert.equal(afterDebit.response.status, 200, JSON.stringify(afterDebit.payload));
  assert.equal(afterDebit.payload.user.points, 1030);
});

test("bet settlement flow", { timeout: 60000 }, async () => {
  const creator = await registerOrLogin({
    name: "Bet Creator",
    email: randomEmail("creator"),
    password: "password123"
  });
  const bettor = await registerOrLogin({
    name: "Bet Bettor",
    email: randomEmail("bettor"),
    password: "password123"
  });

  const closesAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const createBet = await jsonRequest({
    url: `${API_URL}/bets`,
    method: "POST",
    token: creator.token,
    body: {
      title: "Test Bet",
      description: "Integration test bet",
      details: "Test details",
      closesAt,
      betType: "multiple",
      options: [
        { label: "Yes", odds: 2.0 },
        { label: "No", odds: 1.5 }
      ]
    }
  });
  assert.equal(createBet.response.status, 201, JSON.stringify(createBet.payload));
  const bet = createBet.payload.bet;
  const winningOption = bet.options[0];

  const buy = await jsonRequest({
    url: `${API_URL}/bets/${bet.id}/buy`,
    method: "POST",
    token: bettor.token,
    body: { optionId: winningOption.id, stakePoints: 100 }
  });
  assert.equal(buy.response.status, 200, JSON.stringify(buy.payload));

  const afterBuy = await jsonRequest({
    url: `${API_URL}/users/${bettor.user.id}`,
    method: "GET",
    token: bettor.token
  });
  assert.equal(afterBuy.response.status, 200, JSON.stringify(afterBuy.payload));
  assert.equal(afterBuy.payload.user.points, 900);

  const resolve = await jsonRequest({
    url: `${API_URL}/admin/bets/${bet.id}/resolve`,
    method: "POST",
    token: adminSession.token,
    body: { resultOptionId: winningOption.id }
  });
  assert.equal(resolve.response.status, 200, JSON.stringify(resolve.payload));

  const waitForResolved = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const betStatus = await jsonRequest({ url: `${API_URL}/bets/${bet.id}`, method: "GET" });
      if (betStatus.payload?.bet?.status === "resolved") {
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
    throw new Error("Bet did not resolve within timeout.");
  };

  await waitForResolved();

  const afterResolve = await jsonRequest({
    url: `${API_URL}/users/${bettor.user.id}`,
    method: "GET",
    token: bettor.token
  });
  assert.equal(afterResolve.response.status, 200, JSON.stringify(afterResolve.payload));
  assert.equal(afterResolve.payload.user.points, 1096);
});
