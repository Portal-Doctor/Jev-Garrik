import { expect, test } from "bun:test";
import { rootHash, sha256Text } from "./hash";

test("root hash is the hash of the path-sorted file-hash list", () => {
  const files = [
    { path: "candles/BBB-USD/2023-10.sqlite", sha256: "bb", bytes: 2 },
    { path: "candles/AAA-USD/2023-11.sqlite", sha256: "aa2", bytes: 2 },
    { path: "candles/AAA-USD/2023-10.sqlite", sha256: "aa1", bytes: 2 },
  ];
  const expected = sha256Text(
    [
      "candles/AAA-USD/2023-10.sqlite\taa1\n",
      "candles/AAA-USD/2023-11.sqlite\taa2\n",
      "candles/BBB-USD/2023-10.sqlite\tbb\n",
    ].join(""),
  );
  expect(rootHash(files)).toBe(expected);
  expect(rootHash(files.slice().reverse())).toBe(expected);
});
