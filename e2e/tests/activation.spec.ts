import { test } from "@playwright/test";
import { launchVSCode } from "../helpers/vscode";

test("Fusen activates in VS Code", async ({}, testInfo) => {
  const { app, window } = await launchVSCode("sample.ts");
  try {
    await window.screenshot({ path: testInfo.outputPath("activation.png") });
  } finally {
    await app.close();
  }
});
