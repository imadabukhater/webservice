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

## النسخ الاحتياطي السحابي / Cloud Backups (Google Compute Engine)

على سيرفر Google Compute Engine يحفظ التطبيق نسخة كاملة من قاعدة البيانات كل يوم في Google Cloud Storage
(مضغوطة، باسم جديد كل مرة، ولا يكتب فوق نسخة قديمة). تظهر حالتها في «الإعدادات» ← «النسخ السحابي التلقائي».

### الإعداد (مرة واحدة)
```bash
B=agents-portal-6476-backups
SA=238738628870-compute@developer.gserviceaccount.com

# المكان: خاص، ولا تُحذف أي نسخة قبل 30 يوماً، وتُحذف تلقائياً بعد 31 يوماً
gcloud storage buckets create gs://$B --location=us-central1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://$B --retention-period=30d
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":31}}]}' > lifecycle.json
gcloud storage buckets update gs://$B --lifecycle-file=lifecycle.json

# السيرفر يضيف نسخاً فقط
gcloud storage buckets add-iam-policy-binding gs://$B --member=serviceAccount:$SA --role=roles/storage.objectCreator
gcloud compute instances add-metadata agents-server --zone us-central1-a --metadata backup-bucket=$B

# صلاحية الكتابة في Cloud Storage للسيرفر (يتطلب إيقافه دقيقة؛ عنوانه ثابت فلا يتغيّر الرابط)
gcloud compute instances stop agents-server --zone us-central1-a
gcloud compute instances set-service-account agents-server --zone us-central1-a --service-account $SA \
  --scopes=storage-rw,logging-write,monitoring-write,pubsub,service-management,service-control,trace
gcloud compute instances start agents-server --zone us-central1-a
```

### الاسترجاع / Restore
```bash
gcloud storage ls gs://$B                              # النسخ المتوفرة، الأحدث آخراً
gcloud storage cp gs://$B/agents-<التاريخ>.db.gz .
gunzip agents-<التاريخ>.db.gz
gcloud compute scp agents-<التاريخ>.db agents-server:/tmp/restore.db --zone us-central1-a
gcloud compute ssh agents-server --zone us-central1-a --command "sudo systemctl stop agents-app && \
  sudo cp /var/lib/agents-app/agents.db /var/lib/agents-app/agents.before-restore.db && \
  sudo rm -f /var/lib/agents-app/agents.db-wal /var/lib/agents-app/agents.db-shm && \
  sudo install -o agents -g agents -m 600 /tmp/restore.db /var/lib/agents-app/agents.db && \
  sudo systemctl start agents-app"
```

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
