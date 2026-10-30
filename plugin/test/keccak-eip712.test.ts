import { describe, expect, test } from "bun:test";
import { addressFromPublicKey, fromHex, keccak256, keccak256Hex, toHex } from "../src/keccak.ts";
import { checksumAddress, isAddress, parseSignature, recoverAddress, sameAddress, signerOfTypedData } from "../src/secp256k1.ts";
import { domainSeparator, encodeType, typedDataDigest, typeHash } from "../src/eip712.ts";

/**
 * The two primitives that make EIP-712 verification possible without a wallet
 * dependency. Every vector here is checked against an independent
 * implementation: `cast keccak` / `cast wallet verify` from foundry 1.8.6, and
 * the EIP-712 specification's own Mail example.
 */
describe("keccak-256", () => {
  // `cast keccak <input>` on foundry 1.8.6
  const vectors: [string, string][] = [
    ["", "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    ["abc", "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
    ["Transfer(address,address,uint256)", "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
    ["Hello, Bob!", "0xb5aadf3154a261abdd9086fc627b61efca26ae5702701d05cd2305f7c52a2fc8"],
  ];
  for (const [input, expected] of vectors) {
    test(`keccak256(${JSON.stringify(input)})`, () => {
      expect(keccak256Hex(input)).toBe(expected);
    });
  }

  test("a multi-block input is absorbed with the right padding", () => {
    // 136 zero bytes = exactly one rate block, so the padding is a whole extra block.
    expect(keccak256Hex(new Uint8Array(136))).toBe("0x3a5912a7c5faa06ee4fe906253e339467a9ce87d533c65be3c15cb231cdb25f9");
    expect(keccak256Hex(new Uint8Array(1))).toBe("0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a");
  });

  test("it is not sha3-256", () => {
    // sha3-256("") is a7ffc6f8…; a copy-paste of a SHA3 implementation would pass
    // every "32 bytes out" assertion and fail this one.
    expect(keccak256Hex("")).not.toBe("0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
  });
});

describe("EIP-712 encoding", () => {
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Mail: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "contents", type: "string" },
    ],
  };
  const domain = {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  };
  const message = {
    from: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
    to: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
    contents: "Hello, Bob!",
  };

  test("encodeType is `Name(type name,...)`", () => {
    expect(encodeType(types, "Mail")).toBe("Mail(address from,address to,string contents)");
  });

  test("typeHash matches cast keccak of the encoded type", () => {
    expect(typeHash(types, "Mail")).toBe("0x536e54c54e6699204b424f41f6dea846ee38ac369afec3e7c141d2c92c65e67f");
  });

  test("domain separator matches the EIP-712 spec value", () => {
    // The spec's own example domain separator.
    expect(domainSeparator(types, domain)).toBe("0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f");
  });

  test("the full digest is reproduced by hand from the spec's intermediate hashes", () => {
    // Built independently with `cast keccak` over the concatenations EIP-712
    // prescribes, so this test does not just restate the implementation.
    expect(typedDataDigest({ types, primaryType: "Mail", domain, message })).toBe(
      "0xd26e78c40dcd18c379ca37f0ae84be81178cfd5c9c46598d8e142648d00edd60",
    );
  });

  test("a declared struct type is expanded into encodeType in dependency order", () => {
    const nested = {
      EIP712Domain: [{ name: "name", type: "string" }],
      Outer: [
        { name: "inner", type: "Inner" },
        { name: "tag", type: "string" },
      ],
      Inner: [{ name: "value", type: "uint256" }],
    };
    expect(encodeType(nested, "Outer")).toBe("Outer(Inner inner,string tag)Inner(uint256 value)");
  });

  test("an undeclared type is refused rather than hashed as zero", () => {
    // encodeType only lists names, so the refusal has to happen where the value
    // is encoded: a struct type with no declaration cannot be hashed.
    expect(() =>
      typedDataDigest({
        types: { EIP712Domain: [{ name: "name", type: "string" }], A: [{ name: "b", type: "Missing" }] },
        primaryType: "A",
        domain: { name: "x" },
        message: { b: 1 },
      }),
    ).toThrow(/Missing/);
  });

  test("a missing message field is refused", () => {
    expect(() =>
      typedDataDigest({ types, primaryType: "Mail", domain, message: { from: message.from, to: message.to } }),
    ).toThrow(/contents/);
  });
});

describe("secp256k1 recovery", () => {
  // Produced with: cast wallet sign "hello" --private-key <anvil account 0>
  const anvil0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const signature = "0xf16ea9a3478698f695fd1401bfe27e9e4a7e8e3da94aa72b021125e31fa899cc573c48ea3fe1d4ab61a9db10c19032026e3ed2dbccba5a178235ac27f94504311c";

  test("an EIP-191 personal_sign digest recovers the signer", () => {
    const digest = keccak256(`\x19Ethereum Signed Message:\n5hello`);
    expect(recoverAddress(digest, signature)).toBe(anvil0.toLowerCase());
  });

  test("the same signature does not recover a signer for another digest", () => {
    const other = keccak256(`\x19Ethereum Signed Message:\n5world`);
    expect(recoverAddress(other, signature)).not.toBe(anvil0.toLowerCase());
  });

  test("a typed-data signature recovers the signer of that document", () => {
    // cast wallet sign --data --from-file mail.json
    const sig = "0x4a0f5e65c47afc007bfde365d02847383e37f861fa57e8ea39c58d31bdbbd70d75043fa314a4fe3b00ff35248ddbeec04bd9ef74c03608b6db66c237338f77a11b";
    expect(signerOfTypedData("0xd26e78c40dcd18c379ca37f0ae84be81178cfd5c9c46598d8e142648d00edd60", sig)).toBe(anvil0.toLowerCase());
  });

  test("a high-s signature is refused (EIP-2 malleability)", () => {
    const parsed = parseSignature(signature);
    const halfN = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    const mirrored = { r: parsed.r, s: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n - parsed.s, v: parsed.v === 0 ? 1 : 0 };
    expect(mirrored.s > halfN).toBe(true);
    const bytes = new Uint8Array(65);
    bytes.set(fromHex(mirrored.r.toString(16).padStart(64, "0")), 0);
    bytes.set(fromHex(mirrored.s.toString(16).padStart(64, "0")), 32);
    bytes[64] = mirrored.v + 27;
    const digest = keccak256(`\x19Ethereum Signed Message:\n5hello`);
    expect(recoverAddress(digest, bytes)).toBeNull();
  });

  test("malformed signatures are refused, never guessed at", () => {
    const digest = keccak256("x");
    expect(recoverAddress(digest, "0x00")).toBeNull();
    expect(recoverAddress(digest, new Uint8Array(65))).toBeNull();
    expect(recoverAddress(new Uint8Array(31), signature)).toBeNull();
  });

  test("a bad recovery byte is refused", () => {
    const bytes = fromHex(signature);
    bytes[64] = 5;
    expect(recoverAddress(keccak256("x"), bytes)).toBeNull();
  });
});

describe("addresses", () => {
  test("EIP-55 checksums match the reference vectors", () => {
    const vectors: [string, string][] = [
      ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
      ["0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"],
      ["0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"],
      ["0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB"],
      ["0xd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"],
    ];
    for (const [lower, checksummed] of vectors) expect(checksumAddress(lower)).toBe(checksummed);
  });

  test("address comparison ignores case but not content", () => {
    expect(sameAddress("0xAbC0000000000000000000000000000000000001", "0xabc0000000000000000000000000000000000001")).toBe(true);
    expect(sameAddress("0xabc0000000000000000000000000000000000001", "0xabc0000000000000000000000000000000000002")).toBe(false);
    expect(sameAddress("0xabc", "0xabc0000000000000000000000000000000000001")).toBe(false);
    expect(sameAddress(null, "0xabc0000000000000000000000000000000000001")).toBe(false);
  });

  test("an address derives from a 64-byte public key", () => {
    // secp256k1 generator's uncompressed key, whose address is well known.
    const gx = fromHex("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const gy = fromHex("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8");
    const pub = new Uint8Array(64);
    pub.set(gx, 0);
    pub.set(gy, 32);
    expect(addressFromPublicKey(pub)).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });

  test("isAddress is strict", () => {
    expect(isAddress("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isAddress("0x0")).toBe(false);
    expect(isAddress("not an address")).toBe(false);
    expect(isAddress(undefined)).toBe(false);
  });

  test("hex round-trips and refuses odd input", () => {
    expect(toHex(fromHex("0xdeadbeef"))).toBe("deadbeef");
    expect(() => fromHex("0xabc")).toThrow();
    expect(() => fromHex("0xzz")).toThrow();
  });
});
