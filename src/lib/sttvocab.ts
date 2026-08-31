// Shared speech-recognition bias prompt — the single biggest lever for "hears
// the right words": both STT lanes are primed with Daniel's actual vocabulary
// (apps, gear, providers, places) so proper nouns stop coming out mangled.
export const STT_PROMPT =
  "Daniel, a British English speaker, talking to JARVIS, his assistant, about his projects and businesses. " +
  "Vocabulary: JARVIS, Hygglo, rental manager, Rental Manager v2, DB Cinema, Leo Adams, Convex, Vercel, " +
  "Trigger.dev, Groq, Mastra, Codex, Luna, Terra, Sol, Novita, Paul, Maya, Chloe, Snuffelo, Shopify, " +
  "Z-Image Turbo, Cloudflare R2, SerpAPI, " +
  "Sony FX3, FX30, A7S III, A7 IV, A7R V, ZV-E1, 24-70 GM, 70-200, DJI, Ronin, gimbal, Aputure, Nanlite, " +
  "PavoTube, Hollyland Pyro, boom mic, YouTube Studio AI, Music House, media engine, app factory, project hub, " +
  "remote work hub, finance engine, DistroKid, RouteNote, Suno, lofi, briefing, itinerary, mind map, " +
  "creations library, wake word, Barcelona, Lisbon, Bali, Booking.com, Airbnb, net worth, to-do list.";
