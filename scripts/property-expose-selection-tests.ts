import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PROPERTY_EXPOSE_MAX_IMAGES, selectPropertyExposePhotos, type PropertyExposeMediaChoice } from "../src/lib/property-expose";

const photo = (id: string): PropertyExposeMediaChoice => ({ id, title: id, url: "", kind: "image", isCover: false });

test("bulk selection preserves chosen cover and order, ignores stale IDs and skips plans", () => {
  const media: PropertyExposeMediaChoice[] = [photo("a"), photo("b"), { ...photo("plan"), kind: "floorplan" }, photo("c")];
  assert.deepEqual(selectPropertyExposePhotos(media, ["c", "a", "deleted", "c"]), ["c", "a", "b"]);
});

test("bulk selection respects the existing PDF limit and preserves the user's chosen photos", () => {
  const media = Array.from({ length: PROPERTY_EXPOSE_MAX_IMAGES + 5 }, (_, index) => photo(String(index)));
  const result = selectPropertyExposePhotos(media, ["24", "23"]);
  assert.equal(result.length, PROPERTY_EXPOSE_MAX_IMAGES);
  assert.deepEqual(result.slice(0, 4), ["24", "23", "0", "1"]);
  assert.equal(new Set(result).size, result.length);
});
