import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rv-review-"));
  const now = Date.now();
  const dates = [2 * 86400, 3 * 3600, 10 * 60].map((seconds) =>
    new Date(now - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  );
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const write = async (name, contents) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Rv Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  await write(".gitignore", "ignored/\n");
  await write(
    "README.md",
    "# Parcel\n\nA small, predictable shipping calculator.\n",
  );
  await write(
    "src/shipping.ts",
    "export interface Order {\n  subtotal: number;\n  country: string;\n}\n\nexport function shippingCost(order: Order): number {\n  const baseRate = 5;\n  return baseRate;\n}\n",
  );
  await write("src/legacy.ts", "export const freeShipping = false;\n");
  git("add", ".");
  git("commit", "-qm", "Add shipping calculator", "--date", dates[0]);
  const first = git("rev-parse", "HEAD");
  await write(
    "src/shipping.ts",
    'export interface Order {\n  subtotal: number;\n  country: string;\n}\n\nexport function shippingCost(order: Order): number {\n  const baseRate = order.country === "DE" ? 5 : 12;\n  return baseRate;\n}\n',
  );
  await write(
    "test/shipping.test.ts",
    'import { shippingCost } from "../src/shipping";\n\n// Domestic and international shipping\nconsole.assert(shippingCost({ subtotal: 20, country: "DE" }) === 5);\nconsole.assert(shippingCost({ subtotal: 20, country: "US" }) === 12);\n',
  );
  git("add", ".");
  git(
    "commit",
    "-qm",
    "Add international shipping rates",
    "-m",
    "Keep domestic shipping at 5.\nCharge 12 for international orders.",
    "--date",
    dates[1],
  );
  const second = git("rev-parse", "HEAD");
  await write(
    "src/shipping.ts",
    'export interface Order {\n  subtotal: number;\n  country: string;\n}\n\nconst FREE_SHIPPING_THRESHOLD = 100;\n\nexport function shippingCost(order: Order): number {\n  if (order.subtotal >= FREE_SHIPPING_THRESHOLD) {\n    return 0;\n  }\n\n  const baseRate = order.country === "DE" ? 5 : 12;\n  return baseRate;\n}\n',
  );
  git("add", "src/shipping.ts");
  git("commit", "-qm", "Introduce free shipping threshold", "--date", dates[2]);
  const third = git("rev-parse", "HEAD");
  await write(
    "src/shipping.ts",
    'export interface Order {\n  subtotal: number;\n  country: string;\n}\n\nconst FREE_SHIPPING_THRESHOLD = 75;\n\nexport function shippingCost(order: Order): number {\n  if (order.subtotal >= FREE_SHIPPING_THRESHOLD) {\n    return 0;\n  }\n\n  const baseRate = order.country === "DE" ? 5 : 12;\n  return Math.round(baseRate * 1.19);\n}\n',
  );
  git("add", "src/shipping.ts");
  await write(
    "src/shipping.ts",
    'export interface Order {\n  subtotal: number;\n  country: string;\n}\n\nconst FREE_SHIPPING_THRESHOLD = 75;\n\nexport function shippingCost(order: Order): number {\n  if (order.subtotal >= FREE_SHIPPING_THRESHOLD) {\n    return 0;\n  }\n\n  const baseRate = order.country === "DE" ? 6 : 14;\n  return Math.round(baseRate * 1.19);\n}\n',
  );
  await rm(path.join(root, "src/legacy.ts"));
  await write(
    "src/discount.ts",
    "export function discount(total: number, percent: number) {\n  return total * (1 - percent / 100);\n}\n",
  );
  await write("ignored/secret.txt", "not in the browser");
  return {
    root,
    git,
    write,
    first,
    second,
    third,
    dates,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log((await fixture()).root);
}
