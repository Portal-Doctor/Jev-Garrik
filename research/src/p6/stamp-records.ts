/**
 * Committed commands that write each P6 record. The writer refuses a frozen
 * name, so these commands reproduce a record only before that name is frozen.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stampFromGit, repoRoot, type ArtifactStamp } from "../manifest";
import { amendment2Body } from "./amendment2";
import { amendment2aBody } from "./amendment2a";
import { amendment2bApprovalBody, amendment2bBody } from "./amendment2b";
import { amendmentV6ApprovalBody, amendmentV6Body } from "./amendment-v6";
import { d1ParityBody } from "./daily";
import { kellyRulingBody, kellyRulingSupersededBody, kellyStatusBody, kellySupersedingBody } from "./kelly";
import { forwardPickBody } from "./select";
import { wideParityReport } from "./parity";
import { assertInsideRepo, assertP6Target, writeP6 } from "./write";

export const P6_STAMP_COMMANDS = [
  "p6-stamp-amendment-2",
  "p6-stamp-amendment-2a",
  "p6-stamp-amendment-2a-approval",
  "p6-stamp-kelly-ruling",
  "p6-stamp-kelly-status",
  "p6-stamp-amendment-2b",
  "p6-stamp-amendment-2b-approval",
  "p6-stamp-amendment-v6",
  "p6-stamp-amendment-v6-approval",
  "p6-stamp-kelly-superseding",
  "p6-stamp-forward-a",
  "p6-stamp-wide-parity",
  "p6-stamp-d1-parity",
  "p6-stamp-kelly-ruling-superseded",
] as const;

export type P6StampCommand = (typeof P6_STAMP_COMMANDS)[number];

function dataRootHash(root: string): string | null {
  const manifest = join(root, "research/data/data-manifest.json");
  if (!existsSync(manifest)) return null;
  const body = JSON.parse(readFileSync(manifest, "utf8")) as { dataRootHash?: string | null };
  return body.dataRootHash ?? null;
}

function approval2aBody(): Record<string, unknown> {
  return {
    amendment2aSha256: "99cab8986102bfddb9dd6579fcb99ffd83ed89f065c009811633e19bd59283a0",
    amendment2aFile: "research/data/reports/p6-amendment-2a.json",
    approvedBy: "Brian",
    approvedAt: "2026-10-12T01:49:00Z",
    confirmedBy: ["Quant", "Trader"],
    commit: "79eebb38ddc99e1e08ec0e6cf587af228ed5deb7",
    registrationEdited: false,
    amendment1Edited: false,
    amendment2Edited: false,
  };
}

function bodyOf(command: P6StampCommand, root = repoRoot()): { file: string; body: Record<string, unknown> } {
  switch (command) {
    case "p6-stamp-amendment-2":
      return { file: "p6-amendment-2.json", body: { ...amendment2Body() } };
    case "p6-stamp-amendment-2a":
      return { file: "p6-amendment-2a.json", body: { ...amendment2aBody() } };
    case "p6-stamp-amendment-2a-approval":
      return { file: "p6-amendment-2a-approval.json", body: approval2aBody() };
    case "p6-stamp-kelly-ruling":
      return { file: "p6-kelly-ruling.json", body: { ...kellyRulingBody() } };
    case "p6-stamp-kelly-status":
      return { file: "p6-kelly-status.json", body: { ...kellyStatusBody() } };
    case "p6-stamp-amendment-2b":
      return { file: "p6-amendment-2b.json", body: { ...amendment2bBody() } };
    case "p6-stamp-amendment-2b-approval":
      return { file: "p6-amendment-2b-approval.json", body: { ...amendment2bApprovalBody() } };
    case "p6-stamp-amendment-v6":
      return { file: "p6-amendment-v6.json", body: { ...amendmentV6Body() } };
    case "p6-stamp-amendment-v6-approval":
      return { file: "p6-amendment-v6-approval.json", body: { ...amendmentV6ApprovalBody() } };
    case "p6-stamp-kelly-superseding":
      return { file: "p6-kelly-superseding.json", body: { ...kellySupersedingBody() } };
    case "p6-stamp-forward-a":
      return { file: "p6-forward-a.json", body: forwardPickBody(root) };
    case "p6-stamp-wide-parity":
      return { file: "p6-wide-parity.json", body: wideParityReport() };
    case "p6-stamp-d1-parity":
      return { file: "p6-d1-parity.json", body: d1ParityBody(root) };
    case "p6-stamp-kelly-ruling-superseded":
      return { file: "p6-kelly-ruling-superseded.json", body: { ...kellyRulingSupersededBody() } };
    default: {
      const never: never = command;
      throw new Error(`unknown P6 stamp ${never}`);
    }
  }
}

export function stampP6Record(command: P6StampCommand, root = repoRoot()): { sha256: string; path: string } {
  const spec = bodyOf(command, root);
  const path = assertInsideRepo(join(root, "research/data/reports", spec.file));
  assertP6Target(path);
  const stamp: ArtifactStamp = stampFromGit({ phaseId: "P6", dataRootHash: dataRootHash(root), cwd: root });
  const written = writeP6(path, spec.body, { stamp, sidecarLabel: `research/data/reports/${spec.file}` });
  return { sha256: written.sha256, path };
}
