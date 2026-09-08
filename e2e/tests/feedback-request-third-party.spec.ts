import {
  test,
  expect,
  login,
  logout,
  typeContent,
  openBell,
  notificationCard,
  pickSelectOption,
  uniqueText,
  MANAGER_AAA,
  AAA_ONE,
  AAA_THREE,
} from "./helpers";

// The manager-driven request flow (RequestFeedback, distinct from the self "Ask for feedback"):
// a manager requests feedback ABOUT a subordinate FROM a third party, with a requester message.
// Verifies the message rides along read-only through triage and the draft editor, and that the
// requester is notified on pick-up and on send.
test("manager requests feedback about a subordinate; provider sees the message, accepts and sends", async ({
  page,
}) => {
  const body = uniqueText("E2E third-party");
  const message = uniqueText("E2E requester-message");

  // Requester: Dashboard → My subordinates → the card's Feedback dropdown (v1.51.0) →
  // "Request feedback for" AAA One, from AAA Three.
  await login(page, MANAGER_AAA);
  await page.goto("/?tab=subordinates");
  await page.getByRole("button", { name: "Feedback actions for AAA One" }).click();
  await page.getByRole("menuitem", { name: "Request feedback about AAA One" }).click();
  await expect(page).toHaveURL(/\/feedback\/request/);
  await pickSelectOption(page, "Add a provider", "AAA Three");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("textbox", { name: "Message to the provider" }).fill(message);
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/feedbacks") && r.request().method() === "POST" && r.ok(),
    ),
    page.getByRole("button", { name: "Request", exact: true }).click(),
  ]);
  const id: number = (await created.json()).id;
  await logout(page);

  // Provider: triage screen shows the parties and the requester's message; Accept → draft editor
  // (message still visible) → write and send.
  await login(page, AAA_THREE);
  await page.goto(`/feedback/${id}/edit`);
  await expect(page.getByRole("heading", { name: "Feedback request" })).toBeVisible();
  await expect(page.getByText("Manager AAA requested feedback from you about AAA One.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message from the requester" })).toHaveValue(message);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/feedbacks/${id}/pick-up`) && r.request().method() === "POST" && r.ok(),
    ),
    page.getByRole("button", { name: "Accept" }).click(),
  ]);
  // In the editor the message sits behind a collapsed toggle; expand it to read it.
  await page.getByRole("button", { name: "Message from the requester" }).click();
  await expect(page.getByText(message)).toBeVisible();
  await typeContent(page, body);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/feedbacks/${id}/send`) && r.request().method() === "POST" && r.ok(),
    ),
    page.getByRole("button", { name: "Save & send" }).click(),
  ]);
  await logout(page);

  // Requester: notified of both the pick-up and the delivery; can read the sent feedback
  // (default visibility Provider + requester + subject includes the requester).
  await login(page, MANAGER_AAA);
  const dialog = await openBell(page);
  await expect(
    notificationCard(dialog, "AAA Three is now drafting feedback about AAA One."),
  ).toBeVisible();
  await expect(
    notificationCard(dialog, "The feedback you requested from AAA Three about AAA One has been sent."),
  ).toBeVisible();
  // Close the modal via Escape — the header X has no reliable accessible name.
  await page.keyboard.press("Escape");
  await page.goto(`/feedback/${id}/view`);
  await expect(page.getByText(body)).toBeVisible();
  await expect(page.getByLabel("Status")).toHaveText("Sent");
});

// The request-feedback expiration presets (v3.8.0, UI only — the time-based auto-reject sweep
// is covered server-side in FeedbackExpiryTest, not here). Reuses this file's triple (subject
// AAA One ← provider AAA Three, requester Manager AAA): the test above already closes its row to
// SENT, freeing the triple for a second REQUESTED row here — closed out via Reject at the end so
// no open row is left behind for a rerun.
test("a fixed-duration expiration preset is set on the request and shown to the provider before they decide", async ({
  page,
}) => {
  await login(page, MANAGER_AAA);
  await page.goto("/?tab=subordinates");
  await page.getByRole("button", { name: "Feedback actions for AAA One" }).click();
  await page.getByRole("menuitem", { name: "Request feedback about AAA One" }).click();
  await expect(page).toHaveURL(/\/feedback\/request/);
  await pickSelectOption(page, "Add a provider", "AAA Three");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("combobox", { name: "Expiration" }).click();
  await page.getByRole("option", { name: "In 1 week" }).click();
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/feedbacks") && r.request().method() === "POST" && r.ok(),
    ),
    page.getByRole("button", { name: "Request", exact: true }).click(),
  ]);
  const body: { id: number; expiresOn: string } = await created.json();
  const expectedLabel = new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
    new Date(`${body.expiresOn}T00:00:00`),
  );
  await logout(page);

  // Provider: the triage screen shows the deadline before they decide (the same field the
  // sweep later acts on server-side).
  await login(page, AAA_THREE);
  await page.goto(`/feedback/${body.id}/edit`);
  await expect(page.getByRole("heading", { name: "Feedback request" })).toBeVisible();
  await expect(page.getByText("Expires on")).toBeVisible();
  await expect(page.getByText(expectedLabel)).toBeVisible();

  // Close the row out so the triple stays free for a rerun of this file.
  await page.getByRole("button", { name: "Reject" }).click();
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/feedbacks/${body.id}/reject`) && r.request().method() === "POST" && r.ok(),
    ),
    page.getByRole("dialog").getByRole("button", { name: "Reject" }).click(),
  ]);
  await logout(page);
});
