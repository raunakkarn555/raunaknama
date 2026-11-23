// Seeds your Firestore "tracks" collection with your playlist.
// Run with: npm run seed
//
// This is a LOCAL-ONLY script (uses firebase-admin, which has full access
// to your project) — it is never deployed and never runs in the browser.
//
// HOW TO GET A youtubeId:
// Open any YouTube video, e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ
// The youtubeId is the part after "v=" -> dQw4w9WgXcQ
//
// Replace the placeholder entries below with songs from your own
// YouTube Music playlist before running this script.
//
// BEFORE RUNNING: you need a service account key at the project root,
// named serviceAccountKey.json. See README section 2, step 4, for how to
// download it. It is already listed in .gitignore — never commit it.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serviceAccount;
try {
  serviceAccount = JSON.parse(
    readFileSync(path.join(__dirname, "..", "serviceAccountKey.json"), "utf-8")
  );
} catch (err) {
  console.error(
    "\nCouldn't find serviceAccountKey.json in the project root.\n" +
      "See README section 2, step 4, for how to download one from your " +
      "Firebase project settings.\n"
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const tracks = [
  {
    youtubeId: "REPLACE_WITH_YOUTUBE_ID_1",
    title: "Replace Me - Song Title",
    artist: "Artist Name",
    order: 1,
  },
  {
    youtubeId: "REPLACE_WITH_YOUTUBE_ID_2",
    title: "Replace Me - Song Title",
    artist: "Artist Name",
    order: 2,
  },
  {
    youtubeId: "REPLACE_WITH_YOUTUBE_ID_3",
    title: "Replace Me - Song Title",
    artist: "Artist Name",
    order: 3,
  },
];

async function run() {
  const tracksCol = db.collection("tracks");

  // Clear out any existing tracks first, so re-running this script always
  // leaves you with exactly the playlist defined above.
  const existing = await tracksCol.get();
  if (!existing.empty) {
    const deleteBatch = db.batch();
    existing.forEach((doc) => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();
  }

  const addBatch = db.batch();
  tracks.forEach((track) => {
    const ref = tracksCol.doc();
    addBatch.set(ref, track);
  });
  await addBatch.commit();

  console.log(`Seeded ${tracks.length} tracks.`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
