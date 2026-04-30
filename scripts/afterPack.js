/**
 * (c) 2026 KickedStorm (kickedstorm.com)
 * Project: AG Browser
 * License: GNU AGPLv3
 * Unauthorized copying of this file is strictly prohibited.
 */
const fs = require('fs');
const path = require('path');

const LOCALIZED_USAGE = {
  Base: {
    camera: 'AG Browser needs camera access so approved websites can use video.',
    microphone: 'AG Browser needs microphone access so approved websites can use audio.'
  },
  en: {
    camera: 'AG Browser needs camera access so approved websites can use video.',
    microphone: 'AG Browser needs microphone access so approved websites can use audio.'
  },
  ru: {
    camera: 'AG Browser нужен доступ к камере, чтобы одобренные вами сайты могли использовать видео.',
    microphone: 'AG Browser нужен доступ к микрофону, чтобы одобренные вами сайты могли использовать звук.'
  },
  es: {
    camera: 'AG Browser necesita acceso a la cámara para que los sitios que apruebes puedan usar vídeo.',
    microphone: 'AG Browser necesita acceso al micrófono para que los sitios que apruebes puedan usar audio.'
  },
  'pt-BR': {
    camera: 'O AG Browser precisa de acesso à câmera para que os sites que você aprovar possam usar vídeo.',
    microphone: 'O AG Browser precisa de acesso ao microfone para que os sites que você aprovar possam usar áudio.'
  },
  de: {
    camera: 'AG Browser benötigt Kamerazugriff, damit von Ihnen freigegebene Websites Video verwenden können.',
    microphone: 'AG Browser benötigt Mikrofonzugriff, damit von Ihnen freigegebene Websites Audio verwenden können.'
  },
  fr: {
    camera: 'AG Browser a besoin de l’accès à la caméra pour que les sites que vous autorisez puissent utiliser la vidéo.',
    microphone: 'AG Browser a besoin de l’accès au microphone pour que les sites que vous autorisez puissent utiliser l’audio.'
  },
  'zh-Hans': {
    camera: 'AG Browser 需要访问摄像头，以便你批准的网站可以使用视频。',
    microphone: 'AG Browser 需要访问麦克风，以便你批准的网站可以使用音频。'
  },
  'zh-Hant': {
    camera: 'AG Browser 需要存取相機，讓你批准的網站可以使用視訊。',
    microphone: 'AG Browser 需要存取麥克風，讓你批准的網站可以使用音訊。'
  },
  ja: {
    camera: 'AG Browser は、許可したサイトでビデオを利用できるようにするためカメラへのアクセスが必要です。',
    microphone: 'AG Browser は、許可したサイトで音声を利用できるようにするためマイクへのアクセスが必要です。'
  },
  ko: {
    camera: 'AG Browser는 승인한 웹사이트가 비디오를 사용할 수 있도록 카메라 접근 권한이 필요합니다.',
    microphone: 'AG Browser는 승인한 웹사이트가 오디오를 사용할 수 있도록 마이크 접근 권한이 필요합니다.'
  },
  it: {
    camera: "AG Browser necessita dell'accesso alla fotocamera affinché i siti che approvi possano usare il video.",
    microphone: "AG Browser necessita dell'accesso al microfono affinché i siti che approvi possano usare l'audio."
  },
  tr: {
    camera: 'AG Browser, onay verdiğiniz sitelerin videoyu kullanabilmesi için kamera erişimine ihtiyaç duyar.',
    microphone: 'AG Browser, onay verdiğiniz sitelerin sesi kullanabilmesi için mikrofon erişimine ihtiyaç duyar.'
  },
  pl: {
    camera: 'AG Browser potrzebuje dostępu do kamery, aby zatwierdzone przez Ciebie strony mogły używać wideo.',
    microphone: 'AG Browser potrzebuje dostępu do mikrofonu, aby zatwierdzone przez Ciebie strony mogły używać dźwięku.'
  },
  uk: {
    camera: 'AG Browser потребує доступу до камери, щоб схвалені вами сайти могли використовувати відео.',
    microphone: 'AG Browser потребує доступу до мікрофона, щоб схвалені вами сайти могли використовувати аудіо.'
  },
  ar: {
    camera: 'يحتاج AG Browser إلى الوصول إلى الكاميرا حتى تتمكن المواقع التي توافق عليها من استخدام الفيديو.',
    microphone: 'يحتاج AG Browser إلى الوصول إلى الميكروفون حتى تتمكن المواقع التي توافق عليها من استخدام الصوت.'
  },
  hi: {
    camera: 'AG Browser को कैमरे की अनुमति चाहिए ताकि जिन साइटों को आप अनुमति दें वे वीडियो का उपयोग कर सकें।',
    microphone: 'AG Browser को माइक्रोफ़ोन की अनुमति चाहिए ताकि जिन साइटों को आप अनुमति दें वे ऑडियो का उपयोग कर सकें।'
  }
};

function escapePlistString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const resourcesDir = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');

  for (const [locale, strings] of Object.entries(LOCALIZED_USAGE)) {
    const lprojDir = path.join(resourcesDir, `${locale}.lproj`);
    fs.mkdirSync(lprojDir, { recursive: true });

    const plistStrings = [
      `"NSCameraUsageDescription" = "${escapePlistString(strings.camera)}";`,
      `"NSMicrophoneUsageDescription" = "${escapePlistString(strings.microphone)}";`
    ].join('\n');

    fs.writeFileSync(path.join(lprojDir, 'InfoPlist.strings'), `${plistStrings}\n`);
  }
};
