INFOGRAPHIC STRUCTURE (for the designed image — our renderer draws all text and icons; you only supply content):
Choose "visual_format" — the layout that best fits the content:
- "tips_poster": 4-6 tips → "items" [{icon, label (max 5 words), detail (max 6 words or "")}]
- "warning_grid": 4-6 warning signs → "items" (detail usually "")
- "condition_awareness": 3-6 key facts about one condition → "items"
- "stat_visual": one VERIFIED FACT → "fact_id" (big number + label + source are drawn automatically)
- "stage_columns": 2-4 stages (e.g. trimesters with weeks) → "stages" [{title, points: 1-3 short points}]
- "myth_table": 1-4 myths → "myths" [{myth, fact}] (each max 10 words)
- "carousel": 4-5 steps → "key_points" (one slide each)
- "story_picture": emotional / doctor-voice posts → an illustration with the hook; no list needed
"icon" must be one of: {icons}.
Every label, point, myth and fact MUST also appear in the caption (the image may not say anything the caption does not).
Keep on-image text tiny: short labels, no sentences longer than 10 words, no numbers except a verified fact or week ranges.

FEW-SHOT EXAMPLES — match this structure and quality exactly (captions shortened here):
Example 1 (tips poster):
{
 "content_type": "pain_solution",
 "visual_format": "tips_poster",
 "topic": "সুস্থ গর্ভাবস্থা",
 "hook": "সুস্থ গর্ভাবস্থার ৬টি সহজ অভ্যাস",
 "overlay_main": "সুস্থ গর্ভাবস্থার ৬টি সহজ অভ্যাস",
 "overlay_sub": "প্রতিদিনের ছোট যত্নেই বড় পরিবর্তন",
 "items": [
  {
   "icon": "water",
   "label": "পর্যাপ্ত পানি পান করুন",
   "detail": "সারাদিন অল্প অল্প করে"
  },
  {
   "icon": "food",
   "label": "সুষম খাবার খান",
   "detail": "ভাত, ডাল, শাক, মাছ, ফল"
  },
  {
   "icon": "sleep",
   "label": "পর্যাপ্ত ঘুমান",
   "detail": "ক্লান্ত লাগলে বিশ্রাম নিন"
  },
  {
   "icon": "walk",
   "label": "হালকা হাঁটাহাঁটি",
   "detail": "চিকিৎসকের পরামর্শ অনুযায়ী"
  },
  {
   "icon": "doctor",
   "label": "নিয়মিত চেকআপ",
   "detail": "কোনো চেকআপ বাদ দেবেন না"
  },
  {
   "icon": "mood_ok",
   "label": "মন ভালো রাখুন",
   "detail": "পরিবারের সাথে কথা বলুন"
  }
 ],
 "stages": [],
 "myths": [],
 "key_points": [],
 "fact_id": "",
 "caption": "…",
 "hashtags": "#গর্ভকালীন_যত্ন",
 "image_prompt": ""
}
Example 2 (statistic):
{
 "content_type": "data_statistics",
 "visual_format": "stat_visual",
 "topic": "এন্ডোমেট্রিওসিস",
 "hook": "মাসিকের তীব্র ব্যথা? এন্ডোমেট্রিওসিস সম্পর্কে জানুন",
 "overlay_main": "মাসিকের তীব্র ব্যথা? এন্ডোমেট্রিওসিস সম্পর্কে জানুন",
 "overlay_sub": "",
 "items": [],
 "stages": [],
 "myths": [],
 "key_points": [],
 "fact_id": "endometriosis_prevalence",
 "caption": "…",
 "hashtags": "#এন্ডোমেট্রিওসিস",
 "image_prompt": ""
}
Example 3 (trimester stages):
{
 "content_type": "educational_carousel",
 "visual_format": "stage_columns",
 "topic": "গর্ভাবস্থার তিন ধাপ",
 "hook": "গর্ভাবস্থার তিন ধাপে কী হয়?",
 "overlay_main": "গর্ভাবস্থার তিন ধাপে কী হয়?",
 "overlay_sub": "",
 "items": [],
 "stages": [
  {
   "title": "প্রথম ধাপ (১–১৩ সপ্তাহ)",
   "points": [
    "ক্লান্তি ও বমি ভাব হতে পারে",
    "প্রথম চেকআপ করিয়ে নিন"
   ]
  },
  {
   "title": "দ্বিতীয় ধাপ (১৪–২৭ সপ্তাহ)",
   "points": [
    "শিশুর নড়াচড়া টের পেতে শুরু করবেন",
    "নিয়মিত চেকআপ চালিয়ে যান"
   ]
  },
  {
   "title": "তৃতীয় ধাপ (২৮–৪০ সপ্তাহ)",
   "points": [
    "শিশুর নড়াচড়ার দিকে খেয়াল রাখুন",
    "প্রসবের প্রস্তুতি নিন"
   ]
  }
 ],
 "myths": [],
 "key_points": [],
 "fact_id": "",
 "caption": "…",
 "hashtags": "#গর্ভাবস্থা",
 "image_prompt": ""
}
