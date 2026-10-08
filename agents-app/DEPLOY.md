# نشر التطبيق • Deployment Guide

## الخيار الأول: Render (الأسهل) / Option 1: Render (Easiest)

### الخطوات / Steps:

1. **إنشء حساب** (Create account):
   - اذهب إلى https://render.com
   - سجل دخول عبر GitHub

2. **انشر التطبيق** (Deploy):
   - انقر "New" > "Web Service"
   - اختر repository: `imadabukhater/webservice`
   - اختر الفرع: `ccr-ab68d4af-p55geh` أو الفرع الذي يحتوي على agents-app
   - في Build Command: `cd agents-app && npm install`
   - في Start Command: `cd agents-app && ADMIN_PASSWORD=$ADMIN_PASSWORD node server.js`
   - في Root Directory: اترك فارغاً (سيبحث عن render.yaml)

3. **أضف متغيرات البيئة** (Add Environment Variables):
   - اضغط "Advanced"
   - أضف متغير:
     - Key: `ADMIN_PASSWORD`
     - Value: كلمة مرور قوية من اختيارك (مثال: `MySecurePass2025!`)

4. **إضافة قرص دائم** (Add Persistent Disk):
   - في "Disks":
     - Path: `/data`
     - Size: 1 GB

5. **انشر** (Deploy):
   - اضغط "Create Web Service"
   - انتظر البناء والنشر (3-5 دقائق)

### الرابط النهائي / Final URL:
```
https://your-service-name.onrender.com
```

---

## الخيار الثاني: Railway / Option 2: Railway

1. اذهب إلى https://railway.app
2. سجل دخول عبر GitHub
3. انقر "New Project" > "Deploy from GitHub repo"
4. اختر `imadabukhater/webservice`
5. أضف متغيرات البيئة:
   ```
   ADMIN_PASSWORD=YourSecurePassword
   NODE_ENV=production
   DB_FILE=/data/agents.db
   PORT=3000
   ```
6. في الإعدادات:
   - Root Directory: `agents-app`
   - Start Command: `ADMIN_PASSWORD=$ADMIN_PASSWORD node server.js`

---

## الخيار الثالث: Fly.io / Option 3: Fly.io

1. اذهب إلى https://fly.io
2. سجل دخول عبر GitHub
3. اتبع الخطوات التفاعلية
4. اختر `imadabukhater/webservice`
5. في fly.toml:
   ```toml
   app = "agents-app"
   primary_region = "cdg"  # اختر منطقة قريبة
   
   [env]
   ADMIN_PASSWORD = "YourSecurePassword"
   NODE_ENV = "production"
   ```

---

## استخدام التطبيق / Using the App

### الخطوة الأولى: الدخول الأول
1. افتح الرابط على https
2. ستُطلب كلمة مرور المدير
3. استخدم:
   - Username: `admin`
   - Password: كلمة المرور التي عيّنتها في البيئة

### إضافة وكلاء / Adding Agents
1. بعد الدخول كمدير
2. اضغط "إضافة وكيل"
3. أعطِ كل وكيل:
   - اسم
   - اسم مستخدم
   - كلمة مرور
   - رصيد افتتاحي

### للهاتف / For Mobile
1. افتح على Chrome (أندرويد) أو Safari (آيفون)
2. اضغط قائمة > "إضافة إلى الشاشة الرئيسية"
3. سيصير مثل تطبيق محلي بدون إنترنت

---

## المشاكل الشائعة / Common Issues

### خطأ "ADMIN_PASSWORD غير محدد"
→ تأكد من تعيين متغير البيئة `ADMIN_PASSWORD`

### قاعدة البيانات تُحذف بعد الإيقاف
→ تأكد من أن القرص الدائم مرتبط بـ `/data`

### الكاميرا لا تعمل
→ تأكد من استخدام HTTPS (جميع المنصات الثلاث توفرها افتراضياً)

---

## الدعم / Support

للمزيد من المعلومات:
- Render: https://render.com/docs/deploy-node
- Railway: https://docs.railway.app
- Fly.io: https://fly.io/docs
