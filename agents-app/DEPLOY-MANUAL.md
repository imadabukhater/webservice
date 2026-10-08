# نشر يدوي على Render (خطوة بخطوة)
# Manual Deployment to Render (Step by Step)

## المرحلة 1: التحضير / Stage 1: Preparation

تأكد من أن لديك:
- ✅ حساب GitHub (لديك بالفعل)
- ✅ بريد إلكتروني صحيح
- ✅ رقم هاتف أو بطاقة ائتمان (Render قد تطلبها للتحقق)

---

## المرحلة 2: إنشء حساب Render / Stage 2: Create Render Account

### الخطوة 1:
انقر على الرابط:
```
https://render.com
```

### الخطوة 2:
اضغط الزر الأزرق "Get Started" أو "Sign Up"

### الخطوة 3:
اختر "GitHub" للدخول عبر حسابك

### الخطوة 4:
اضغط "Authorize render-rnw" لتعطيء الوصول إلى repos الخاص بك

---

## المرحلة 3: إنشاء Web Service / Stage 3: Create Web Service

### الخطوة 1:
من لوحة التحكم، اضغط الزر البرتقالي:
```
"New" أو "Create" → "Web Service"
```

### الخطوة 2:
اختر repository:
- ابحث عن: `webservice`
- اختر: `imadabukhater/webservice`
- اضغط "Connect"

### الخطوة 3:
ملء البيانات كالتالي:

| الحقل | القيمة |
|------|-------|
| **Name** | `agents-app` |
| **Root Directory** | `agents-app` |
| **Environment** | `Docker` |
| **Dockerfile Path** | `Dockerfile` |
| **Branch** | `ccr-ab68d4af-p55geh` |

### الخطوة 4:
اضغط "Advanced" وأضف:
- **Environment Variable:**
  - Name: `ADMIN_PASSWORD`
  - Value: أكتب كلمة مرور قوية (مثال: `Agents2025Secure!`)
  - Click "Add"

### الخطوة 5:
أضف Disk (التخزين الدائم):
- اضغط "Add Disk"
- **Name:** `data`
- **Mount Path:** `/data`
- **Size:** `1 GB`

### الخطوة 6:
ملخص الخيارات (تحقق):
```
✓ Name: agents-app
✓ Environment: Docker
✓ Auto-Deploy: ON
✓ ADMIN_PASSWORD: [محدد]
✓ Disk /data: 1GB
```

### الخطوة 7:
اضغط الزر الأزرق:
```
"Create Web Service"
```

---

## المرحلة 4: الانتظار والتفعيل / Stage 4: Wait & Activate

### ستشوف:
- شريط تقدم أزرق (يعني التطبيق يُبنى)
- في الـ Logs ستشوف:
  ```
  > npm install
  > node server.js
  Server running on port 3000
  ```

### الوقت المتوقع:
- البناء الأول: 3-5 دقائق
- الإعادات الثانية: 30 ثانية

### عندما تتم:
ستظهر رسالة خضراء:
```
✓ Live
```

والرابط الخاص بك:
```
https://agents-app-XXXX.onrender.com
```

---

## المرحلة 5: الدخول الأول / Stage 5: First Login

### اذهب إلى الرابط:
```
https://agents-app-XXXX.onrender.com
```

### ستُطلب بيانات الدخول:
```
Username: admin
Password: [الكلمة التي كتبتها في المرحلة 3]
```

### عند الدخول:
ستشوف لوحة التحكم والقوائم الجانبية ✓

---

## المرحلة 6: إضافة الوكلاء / Stage 6: Add Agents

### من اللوحة:
1. اضغط "إضافة وكيل"
2. أدخل:
   - اسم الوكيل (مثال: "أحمد")
   - اسم مستخدم (مثال: "ahmad")
   - كلمة مرور (مثال: "Pass123!")
   - رصيد افتتاحي (مثال: "1000")
3. اضغط "إضافة الوكيل"

### للوكيل:
أعطِه:
- اسم المستخدم: `ahmad`
- كلمة المرور: `Pass123!`
- الرابط: `https://agents-app-XXXX.onrender.com`

---

## المرحلة 7: للهاتف / Stage 7: Mobile Setup

### على Android (Chrome):
1. افتح الرابط على Chrome
2. اضغط ≡ (ثلاث نقاط)
3. اضغط "إضافة إلى الشاشة الرئيسية"
4. اضغط "إضافة"

### على iPhone (Safari):
1. افتح الرابط على Safari
2. اضغط مشاركة ⬆️
3. اضغط "إضافة إلى الشاشة الرئيسية"
4. اضغط "إضافة"

---

## مشاكل شائعة / Common Issues

### ❌ "Service not found" أو "502 Bad Gateway"
- الخدمة لم تنته من البناء بعد
- انتظر 2-3 دقائق
- تحديث الصفحة (Refresh)

### ❌ "ADMIN_PASSWORD is not set"
- تأكد من أنك أضفت متغير البيئة بشكل صحيح
- اذهب إلى Settings → Environment
- اضغط "Redeploy"

### ❌ "Cannot find Dockerfile"
- تأكد أن Root Directory = `agents-app`
- الـ Dockerfile يجب أن يكون في: `agents-app/Dockerfile`

### ❌ الكاميرا لا تعمل
- تأكد أنك تستخدم HTTPS (وليس HTTP)
- Render توفر HTTPS افتراضياً ✓

### ❌ قاعدة البيانات تُحذف عند الإيقاف
- تأكد من أنك أضفت Disk:
  - Mount Path: `/data`
  - يجب أن تكون في "Disks" وليس في Environment

---

## إذا حدثت مشكلة / If Issues Occur

1. اذهب إلى: Settings → Logs
2. ابحث عن الرسالة الحمراء
3. نسخ الرسالة كاملة
4. ضع issue على GitHub

---

## النجاح! ✅

إذا شفت:
- ✓ Live (أخضر)
- ✓ شاشة تسجيل الدخول
- ✓ لوحة التحكم

يعني التطبيق اشتغل بنجاح! 🎉

الرابط الخاص بك جاهز للاستخدام! 🚀
