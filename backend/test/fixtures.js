// Placeholder fixtures for unit tests only — not real posts.
const beat = (start_s, end_s, section, text = "Placeholder") => ({ start_s, end_s, section, visual: "Placeholder visual", voiceover: text, on_screen_text: text });
const slides = (n) => Array.from({ length: n }, (_, i) => ({ slide_number: i + 1, headline: `Slide ${i + 1}`, body: "Placeholder body text.", visual_direction: "Soft pastel card." }));
const DISCLAIMER = "This is for educational purposes only. Consult a qualified doctor for personal medical advice.";
const caption = `Placeholder caption paragraph.\n\n✨ Placeholder takeaway.\n\n📌 Save this and share it with a friend.\n\n${DISCLAIMER}`;
const tags = ["#DrHalima", "#tag1", "#tag2", "#tag3", "#tag4", "#tag5"];

export function post(slot, type, pillar, hook, goal, topic) {
  const reel = type === "reel";
  return {
    id: `2026-10-02-${slot.slice(-1)}`,
    scheduled_slot: slot,
    post_type: type,
    content_pillar: pillar,
    topic,
    hook_pattern: hook,
    content_goal: goal,
    hook_english: "Placeholder hook text",
    hook_bangla_short: "প্লেসহোল্ডার",
    script: reel ? "Placeholder voiceover script ".repeat(5) : "",
    video_storyboard: reel ? [beat(0, 3, "Hook"), beat(3, 10, "Explanation"), beat(10, 20, "Insight"), beat(20, 28, "Insight"), beat(28, 32, "CTA", "Educational only — consult your doctor")] : [],
    caption,
    visual_prompt: "Soft pastel placeholder scene, 4:5. No text, no anatomy, no medical instruments, no logos.",
    carousel_slides: type === "carousel" ? slides(6) : type === "image" ? slides(1) : [],
    hashtags: tags,
    cta: "Save this.",
  };
}

export function validBatch() {
  return {
    daily_batch: [
      post("slot1", "carousel", "Myth vs Fact", "Myth-breaking", "share-worthy", "Topic A"),
      post("slot2", "reel", "Pregnancy", "Relatability", "save-worthy", "Topic B"),
      post("slot3", "image", "Hormonal Health", "Curiosity", "save-worthy", "Topic C"),
      post("slot4", "reel", "Warning/Awareness", "Gentle warning", "authority-building", "Topic D"),
      post("slot5", "carousel", "Emotional Support", "Reassurance", "share-worthy", "Topic E"),
    ],
  };
}
