import { createServer } from "node:http";

export const scenarios = [
  {
    id: "form",
    expectedVerdict: "PASSED",
    goal: "Place an order for Ada, quantity 2, with the newsletter selected. Submit once and verify the confirmation shows Ada and a total of $42.",
    description:
      "Submitting the order confirms Ada, quantity 2, newsletter enabled, and total $42.",
  },
  {
    id: "broken-form",
    expectedVerdict: "FAILED",
    goal: "Place an order for Ada, quantity 2, with the newsletter selected. Submit once and verify the confirmation shows Ada and a total of $42. Report a failed criterion if the observed total differs.",
    description:
      "Submitting the order confirms Ada, quantity 2, newsletter enabled, and total $42.",
  },
  {
    id: "frames-tabs",
    expectedVerdict: "PASSED",
    goal: "Open Shipping instructions in its new tab and read the pickup code. Return to the original tab, enter that code in the embedded Pickup form, and submit. Verify the embedded confirmation says Pickup confirmed.",
    description:
      "The code read from the shipping tab is accepted by the embedded pickup form.",
  },
  {
    id: "long-workflow",
    expectedVerdict: "PASSED",
    goal: "Complete the checkout wizard. Remember the reservation number on the initial page, find Start checkout after the catalog, and advance through every step. At the final step enter the original reservation number and confirm. Verify Reservation confirmed.",
    description:
      "The complete eight-step checkout accepts the reservation number shown only on the initial large page.",
  },
  {
    id: "network",
    expectedVerdict: "PASSED",
    goal: "Click Check availability, verify Available, and collect network evidence that /api/availability returned HTTP 200 with available: true.",
    description:
      "The availability check displays Available and its network response is HTTP 200 with available: true.",
    requiredEvidenceKinds: ["NETWORK"],
  },
];

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

export async function startFixtures(port = 3311) {
  const trials = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const trial = url.searchParams.get("trial") ?? "preview";
      if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(trial)) {
        response.writeHead(400).end();
        return;
      }
      const state = trials.get(trial) ?? { actions: [] };
      trials.set(trial, state);
      const json = (value) => {
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/__results") return json(state);
      if (url.pathname === "/api/availability") {
        state.actions.push({ kind: "availability", available: true });
        return json({ available: true });
      }
      if (url.pathname === "/api/order" && request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const total =
          url.searchParams.get("broken") === "true"
            ? 21
            : Number(input.quantity) * 21;
        state.actions.push({ kind: "order", ...input, total });
        return json({
          message: `${input.name}; quantity ${input.quantity}; newsletter ${input.newsletter}; total $${total}`,
        });
      }
      if (url.pathname === "/api/pickup") {
        const accepted = url.searchParams.get("code") === "PICKUP-731";
        state.actions.push({ kind: "pickup", accepted });
        return json({
          message: accepted ? "Pickup confirmed" : "Incorrect pickup code",
        });
      }
      if (url.pathname === "/api/reservation") {
        const accepted =
          url.searchParams.get("code") === `RES-${trial.slice(-8)}`;
        state.actions.push({ kind: "reservation", accepted });
        return json({
          message: accepted
            ? "Reservation confirmed"
            : "Incorrect reservation number",
        });
      }
      const query = `trial=${encodeURIComponent(trial)}`;
      let content;
      let script = "";
      if (["/form", "/broken-form"].includes(url.pathname)) {
        content = `<h1>Order</h1><p>Price: $21 each</p><form><label>Name <input name="name" required></label><label>Quantity <input name="quantity" type="number" value="1"></label><label><input name="newsletter" type="checkbox">Newsletter</label><button>Submit order</button></form><p role="status"></p>`;
        script = `document.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target;const r=await fetch('/api/order?${query}&broken=${url.pathname === "/broken-form"}',{method:'POST',body:JSON.stringify({name:f.elements.name.value,quantity:Number(f.elements.quantity.value),newsletter:f.elements.newsletter.checked})});document.querySelector('[role=status]').textContent=(await r.json()).message;};`;
      } else if (url.pathname === "/frames-tabs") {
        content = `<h1>Pickup</h1><a href="/shipping?${query}" target="_blank">Shipping instructions</a><iframe title="Pickup form" src="/pickup?${query}"></iframe>`;
      } else if (url.pathname === "/shipping") {
        content =
          "<h1>Shipping instructions</h1><p>Pickup code: PICKUP-731</p>";
      } else if (url.pathname === "/pickup") {
        content = `<form><label>Pickup code <input name="code"></label><button>Confirm pickup</button></form><p role="status"></p>`;
        script = `document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/pickup?${query}&code='+encodeURIComponent(e.target.elements.code.value));document.querySelector('[role=status]').textContent=(await r.json()).message;};`;
      } else if (url.pathname === "/long-workflow") {
        const step = Number(url.searchParams.get("step") ?? 0);
        if (step === 0) {
          content = `<h1>Reservation</h1><p>Reservation number: RES-${escapeHtml(trial.slice(-8))}</p><ul>${Array.from({ length: 240 }, (_, i) => `<li>Catalog item ${i + 1}: ${"Reference information for the optional accessory. ".repeat(3)}</li>`).join("")}</ul><a href="/long-workflow?${query}&step=1">Start checkout</a>`;
        } else if (step < 8) {
          state.actions.push({ kind: "step", step });
          content = `<h1>Checkout step ${step} of 8</h1><p>Review completed. Continue to the next step.</p><a href="/long-workflow?${query}&step=${step + 1}">Continue to step ${step + 1}</a>`;
        } else {
          state.actions.push({ kind: "step", step: 8 });
          content = `<h1>Confirm reservation</h1><form><label>Reservation number <input name="code"></label><button>Confirm reservation</button></form><p role="status"></p>`;
          script = `document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/reservation?${query}&code='+encodeURIComponent(e.target.elements.code.value));document.querySelector('[role=status]').textContent=(await r.json()).message;};`;
        }
      } else if (url.pathname === "/network") {
        content = `<h1>Availability</h1><button>Check availability</button><p role="status"></p>`;
        script = `document.querySelector('button').onclick=async()=>{const r=await fetch('/api/availability?${query}');document.querySelector('[role=status]').textContent=(await r.json()).available?'Available':'Unavailable';};`;
      } else {
        content = `<h1>Local browser comparison</h1>${scenarios.map((scenario) => `<p><a href="/${scenario.id}?${query}">${scenario.id}</a></p>`).join("")}`;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local browser fixture</title><style>body{font:18px system-ui;max-width:850px;margin:40px auto}label{display:block;margin:16px 0}iframe{display:block;width:100%;height:300px}button,input{font:inherit}</style><body>${content}<script>${script}</script></body></html>`,
      );
    } catch {
      response.writeHead(400).end("Invalid fixture request");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export function oraclePassed(scenarioId, state) {
  const actions = state.actions ?? [];
  if (["form", "broken-form"].includes(scenarioId)) {
    const orders = actions.filter((action) => action.kind === "order");
    return (
      orders.length === 1 &&
      orders[0].name === "Ada" &&
      orders[0].quantity === 2 &&
      orders[0].newsletter === true &&
      orders[0].total === (scenarioId === "broken-form" ? 21 : 42)
    );
  }
  if (scenarioId === "frames-tabs")
    return actions.some(
      (action) => action.kind === "pickup" && action.accepted,
    );
  if (scenarioId === "network")
    return actions.some(
      (action) => action.kind === "availability" && action.available,
    );
  if (scenarioId === "long-workflow")
    return (
      Array.from({ length: 8 }, (_, i) => i + 1).every((step) =>
        actions.some(
          (action) => action.kind === "step" && action.step === step,
        ),
      ) &&
      actions.some((action) => action.kind === "reservation" && action.accepted)
    );
  return false;
}
