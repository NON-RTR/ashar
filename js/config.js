// ============ أسهَر — إعداد المزامنة العائلية ============
// لتفعيل المزامنة التلقائية بين أجهزة العائلة:
//   1) سوِّ مشروع مجاني على supabase.com
//   2) شغّل ملف supabase/schema.sql في SQL Editor
//   3) من Project Settings → API انسخ الـ URL والـ anon public key وحطهم تحت
//
// الـ anon key مصمَّم ليكون عاماً (آمن يُنشر) — حماية البيانات عبر سرّية «رمز العائلة».
// لو تركتهم فاضيين، التطبيق يشتغل محلياً + روابط المشاركة كما هو، بدون مزامنة.

export const CONFIG = {
  SUPABASE_URL: "https://vguxkewwerxvhrdnqsyv.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_lIgypuHCF4maE6LL8beFvg_WBfxTBLJ",
};
