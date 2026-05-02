// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Sonoglyph} from "../src/Sonoglyph.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * Coverage:
 *   - happy-path mint (owner-only) emits event, increments id, stores struct
 *   - non-owner cannot mint (Ownable revert)
 *   - input validation: zero `to`, empty glyph, empty audioCid all revert
 *   - tokenURI returns a `data:application/json;base64,` payload whose decoded
 *     JSON contains the journal as description + an SVG-dataURL image +
 *     an HTML-dataURL animation_url that embeds the glyph and references
 *     the audio via an IPFS gateway
 *   - tokenURI on a non-existent tokenId reverts with the standard ERC-721
 *     "nonexistent token" error
 *   - JSON escaping: a journal containing `"` and newlines decodes back to
 *     valid JSON without breaking the wrapper
 */
contract SonoglyphTest is Test {
    Sonoglyph internal nft;
    address internal bridge = makeAddr("bridge");
    address internal player = makeAddr("player");

    string constant SAMPLE_GLYPH = ". - + . / \\ |\n - * o + - . *\n + . / | \\ - +";
    string constant SAMPLE_JOURNAL =
        "We descended past the seventh marker. The drone bent into a chord. "
        "I remember the silence between strikes more than the bells themselves.";
    string constant SAMPLE_CID = "bafkreih5ftxqmguzesyeqzbuxh5fsk26sqmjvquw4oem2rof2tjwhymwhu";
    string constant SAMPLE_CODE = "3TSL8X";

    function setUp() public {
        nft = new Sonoglyph(bridge);
    }

    // -------------------------------------------------------------------------
    // Mint
    // -------------------------------------------------------------------------

    function test_constructor_setsOwnerAndMetadata() public view {
        assertEq(nft.owner(), bridge);
        assertEq(nft.name(), "Sonoglyph");
        assertEq(nft.symbol(), "SGLYPH");
        assertEq(nft.lastTokenId(), 0);
    }

    function test_mintDescent_byOwner_succeeds() public {
        vm.prank(bridge);
        uint256 id = nft.mintDescent(
            player,
            SAMPLE_GLYPH,
            SAMPLE_JOURNAL,
            SAMPLE_CID,
            SAMPLE_CODE
        );
        assertEq(id, 1);
        assertEq(nft.lastTokenId(), 1);
        assertEq(nft.ownerOf(1), player);
        assertEq(nft.balanceOf(player), 1);
    }

    function test_mintDescent_storesAllFields() public {
        vm.prank(bridge);
        uint256 id = nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);
        Sonoglyph.Descent memory d = nft.descentOf(id);
        assertEq(d.glyph, SAMPLE_GLYPH);
        assertEq(d.journal, SAMPLE_JOURNAL);
        assertEq(d.audioCid, SAMPLE_CID);
        assertEq(d.sessionCode, SAMPLE_CODE);
        assertEq(d.creator, player);
        assertEq(d.mintedAt, uint64(block.timestamp));
    }

    function test_mintDescent_emitsEvent() public {
        vm.expectEmit(true, true, false, true, address(nft));
        emit Sonoglyph.DescentMinted(1, player, SAMPLE_CODE, SAMPLE_CID);
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);
    }

    function test_mintDescent_idsAreSequential() public {
        // Three different recipients — same address would now revert under
        // the one-mint-per-address rule, so we need fresh `to`s here.
        address p1 = makeAddr("p1");
        address p2 = makeAddr("p2");
        address p3 = makeAddr("p3");
        vm.startPrank(bridge);
        uint256 id1 = nft.mintDescent(p1, SAMPLE_GLYPH, "j1", SAMPLE_CID, "AAAAAA");
        uint256 id2 = nft.mintDescent(p2, SAMPLE_GLYPH, "j2", SAMPLE_CID, "BBBBBB");
        uint256 id3 = nft.mintDescent(p3, SAMPLE_GLYPH, "j3", SAMPLE_CID, "CCCCCC");
        vm.stopPrank();
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
    }

    // -------------------------------------------------------------------------
    // Supply cap + per-wallet limit
    // -------------------------------------------------------------------------

    function test_constants_maxSupplyIs250() public view {
        assertEq(nft.MAX_SUPPLY(), 250);
    }

    function test_mintDescent_revertsOverMaxSupply() public {
        // Mint MAX_SUPPLY (250) tokens to 250 different addresses.
        vm.startPrank(bridge);
        for (uint256 i = 1; i <= 250; i++) {
            address to = address(uint160(0x1000 + i));
            nft.mintDescent(to, SAMPLE_GLYPH, "j", SAMPLE_CID, "AAAAAA");
        }
        assertEq(nft.lastTokenId(), 250);
        // 251st mint to a fresh address must revert.
        address overflowTo = address(uint160(0x9999));
        vm.expectRevert(bytes("max supply"));
        nft.mintDescent(overflowTo, SAMPLE_GLYPH, "j", SAMPLE_CID, "AAAAAA");
        vm.stopPrank();
    }

    function test_mintDescent_revertsOnSecondMintToSameAddress() public {
        vm.startPrank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);
        vm.expectRevert(bytes("already minted"));
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, "ZZZZZZ");
        vm.stopPrank();
    }

    function test_mintDescent_secondMintAfterTransferStillReverts() public {
        // The hasMinted flag is permanent. Transferring the token away
        // doesn't reset eligibility — same address still cannot mint again.
        address other = makeAddr("other");
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);

        vm.prank(player);
        nft.transferFrom(player, other, 1);
        assertEq(nft.balanceOf(player), 0, "player should hold 0 after transfer");
        assertTrue(nft.hasMinted(player), "hasMinted flag should persist");

        vm.expectRevert(bytes("already minted"));
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, "ZZZZZZ");
    }

    function test_hasMinted_setOnFirstMint() public {
        assertFalse(nft.hasMinted(player), "starts unminted");
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);
        assertTrue(nft.hasMinted(player), "set after first mint");
    }

    // -------------------------------------------------------------------------
    // Access control
    // -------------------------------------------------------------------------

    function test_mintDescent_byNonOwner_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, player)
        );
        vm.prank(player);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);
    }

    function test_mintDescent_zeroTo_reverts() public {
        vm.expectRevert(bytes("to=0"));
        vm.prank(bridge);
        nft.mintDescent(address(0), SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);
    }

    function test_mintDescent_emptyGlyph_reverts() public {
        vm.expectRevert(bytes("empty glyph"));
        vm.prank(bridge);
        nft.mintDescent(player, "", SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);
    }

    function test_mintDescent_emptyAudioCid_reverts() public {
        vm.expectRevert(bytes("empty audioCid"));
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, "", SAMPLE_CODE);
    }

    // -------------------------------------------------------------------------
    // tokenURI
    // -------------------------------------------------------------------------

    function test_tokenURI_returnsBase64Json() public {
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);

        string memory uri = nft.tokenURI(1);
        // Strip prefix
        bytes memory uriBytes = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        assertGt(uriBytes.length, prefix.length, "uri too short");
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(uriBytes[i], prefix[i]);
        }

        // Decode base64 chunk after the prefix.
        bytes memory b64 = _slice(uriBytes, prefix.length, uriBytes.length - prefix.length);
        string memory json = string(_decodeB64(b64));

        // Smoke-check the JSON structure.
        assertTrue(_contains(json, '"name":"Sonoglyph #1"'));
        assertTrue(_contains(json, "We descended past the seventh marker"));
        assertTrue(_contains(json, "data:image/svg+xml;base64,"));
        // animation_url is now a self-contained HTML dataURL, not an
        // ipfs:// link to raw audio. The audio CID itself lives inside
        // the decoded HTML — see test_tokenURI_animationUrlIsValidHtml.
        assertTrue(_contains(json, '"animation_url":"data:text/html;base64,'));
        assertTrue(_contains(json, '"external_url":"https://sonoglyph.xyz"'));
        assertTrue(_contains(json, string.concat('"value":"', SAMPLE_CODE, '"')));
    }

    function test_tokenURI_animationUrlIsValidHtml() public {
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);

        string memory uri = nft.tokenURI(1);
        string memory json =
            string(_decodeB64(_after(bytes(uri), bytes("data:application/json;base64,"))));

        // Pull the animation_url HTML payload back out and decode it.
        bytes memory anchor = bytes('"animation_url":"data:text/html;base64,');
        bytes memory afterAnchor = _after(bytes(json), anchor);
        uint256 quoteAt = _indexOf(afterAnchor, bytes('"'));
        bytes memory htmlB64 = _slice(afterAnchor, 0, quoteAt);
        string memory html = string(_decodeB64(htmlB64));

        // Required structural pieces.
        assertTrue(_contains(html, "<!doctype html>"));
        assertTrue(_contains(html, "<audio"));
        // Audio src must point at a public IPFS gateway (ipfs.io) carrying
        // the descent's CID — that's the link that lets a marketplace iframe
        // actually play the audio without needing the `ipfs://` scheme.
        assertTrue(_contains(html, string.concat("https://ipfs.io/ipfs/", SAMPLE_CID)));
        // Glyph is embedded verbatim (escaped) so the visual matches the SVG.
        assertTrue(_contains(html, ". - + ."));
        // Footer carries the brand + session code.
        assertTrue(_contains(html, "SONOGLYPH"));
        assertTrue(_contains(html, SAMPLE_CODE));
    }

    function test_tokenURI_animationUrlEscapesHtmlInGlyph() public {
        // A glyph containing characters that MUST be HTML-escaped to avoid
        // breaking the surrounding markup. If escaping fails, the `<` would
        // start a fake tag and the page would render incorrectly.
        string memory tricky = "< > & \" '";
        vm.prank(bridge);
        nft.mintDescent(player, tricky, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);

        string memory uri = nft.tokenURI(1);
        string memory json =
            string(_decodeB64(_after(bytes(uri), bytes("data:application/json;base64,"))));
        bytes memory anchor = bytes('"animation_url":"data:text/html;base64,');
        bytes memory afterAnchor = _after(bytes(json), anchor);
        uint256 quoteAt = _indexOf(afterAnchor, bytes('"'));
        string memory html = string(_decodeB64(_slice(afterAnchor, 0, quoteAt)));

        // The glyph block should contain entity-encoded versions, NOT raw
        // markup characters. We look for the entities we expect to see.
        assertTrue(_contains(html, "&lt;"));
        assertTrue(_contains(html, "&gt;"));
        assertTrue(_contains(html, "&amp;"));
        assertTrue(_contains(html, "&quot;"));
        assertTrue(_contains(html, "&apos;"));
    }

    function test_tokenURI_imagePayloadIsValidSvg() public {
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, SAMPLE_JOURNAL, SAMPLE_CID, SAMPLE_CODE);

        string memory uri = nft.tokenURI(1);
        // Decode outer JSON.
        string memory json =
            string(_decodeB64(_after(bytes(uri), bytes("data:application/json;base64,"))));
        // Find the image dataURL string.
        bytes memory imgPrefix = bytes('"image":"data:image/svg+xml;base64,');
        bytes memory afterImg = _after(bytes(json), imgPrefix);
        // The base64 SVG runs until the next double-quote.
        uint256 quoteAt = _indexOf(afterImg, bytes('"'));
        bytes memory svgB64 = _slice(afterImg, 0, quoteAt);
        bytes memory svg = _decodeB64(svgB64);
        // Validate it parses as SVG.
        assertTrue(_contains(string(svg), "<svg "));
        assertTrue(_contains(string(svg), "SONOGLYPH"));
        assertTrue(_contains(string(svg), SAMPLE_CODE));
    }

    function test_tokenURI_jsonEscapesQuotesAndNewlines() public {
        string memory tricky = 'A "quoted" line\nwith newline and \\backslash';
        vm.prank(bridge);
        nft.mintDescent(player, SAMPLE_GLYPH, tricky, SAMPLE_CID, SAMPLE_CODE);

        string memory uri = nft.tokenURI(1);
        string memory json =
            string(_decodeB64(_after(bytes(uri), bytes("data:application/json;base64,"))));
        // Quotes must be escaped.
        assertTrue(_contains(json, 'A \\"quoted\\" line'));
        // Newline must become \n (the two-char escape, not a raw 0x0a).
        assertTrue(_contains(json, "with newline"));
        bytes memory jb = bytes(json);
        for (uint256 i = 0; i < jb.length; i++) {
            // No raw newline survives in the description span — the only newlines
            // in valid JSON are inside escaped sequences which are 2 bytes (\n)
            // not a literal LF.
            require(jb[i] != 0x0a, "raw newline in JSON output");
        }
    }

    function test_tokenURI_revertsForUnknownToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999)
        );
        nft.tokenURI(999);
    }

    function test_descentOf_revertsForUnknownToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 42)
        );
        nft.descentOf(42);
    }

    // -------------------------------------------------------------------------
    // Helpers — minimal byte/string utilities. Forge-std doesn't ship them.
    // -------------------------------------------------------------------------

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0) return true;
        if (h.length < n.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function _indexOf(bytes memory hay, bytes memory needle) internal pure returns (uint256) {
        require(hay.length >= needle.length, "indexOf: hay too short");
        for (uint256 i = 0; i <= hay.length - needle.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        revert("indexOf: not found");
    }

    function _slice(bytes memory data, uint256 start, uint256 len)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = data[start + i];
        return out;
    }

    function _after(bytes memory hay, bytes memory needle) internal pure returns (bytes memory) {
        uint256 idx = _indexOf(hay, needle);
        return _slice(hay, idx + needle.length, hay.length - (idx + needle.length));
    }

    /// @dev Tiny Base64 decoder so test assertions can read the JSON back.
    function _decodeB64(bytes memory data) internal pure returns (bytes memory) {
        // Use a lookup table of the 64 alphabet chars.
        bytes memory alpha =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        // Build inverse map.
        uint8[256] memory inv;
        for (uint256 i = 0; i < 64; i++) inv[uint8(alpha[i])] = uint8(i);

        // Strip padding.
        uint256 dataLen = data.length;
        while (dataLen > 0 && data[dataLen - 1] == "=") dataLen--;
        // Output length = (dataLen * 3) / 4 (rounded down).
        uint256 outLen = (dataLen * 3) / 4;
        bytes memory out = new bytes(outLen);

        uint256 oi;
        for (uint256 i = 0; i < dataLen; i += 4) {
            uint32 chunk = uint32(inv[uint8(data[i])]) << 18;
            if (i + 1 < dataLen) chunk |= uint32(inv[uint8(data[i + 1])]) << 12;
            if (i + 2 < dataLen) chunk |= uint32(inv[uint8(data[i + 2])]) << 6;
            if (i + 3 < dataLen) chunk |= uint32(inv[uint8(data[i + 3])]);
            if (oi < outLen) out[oi++] = bytes1(uint8((chunk >> 16) & 0xff));
            if (oi < outLen) out[oi++] = bytes1(uint8((chunk >> 8) & 0xff));
            if (oi < outLen) out[oi++] = bytes1(uint8(chunk & 0xff));
        }
        return out;
    }
}
