// Przechwytywanie dzwieku z JEDNEGO procesu (Windows Process Loopback).
//
// Dowod, ze API dziala per-proces, jest w ../probe.cpp i w README:
// proces grajacy dal 476 032 niezerowe probki, cichy w tym samym czasie 0.
//
// Podzial watkow: cala obsluga COM/WASAPI siedzi na watku roboczym (wlasne
// apartment MTA), a gotowe probki wedruja na watek JS przez
// ThreadSafeFunction. start() czeka tylko na sygnal "otwarte albo padlo",
// zeby blad aktywacji byl zwyklym wyjatkiem JS, a nie cisza w streamie.

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

// Process loopback NIE wspiera GetMixFormat — format trzeba podac wprost.
constexpr WORD KANALY = 2;
constexpr DWORD CZESTOTLIWOSC = 48000;
constexpr WORD BITY = 32;  // float32
constexpr WORD BLOK = KANALY * BITY / 8;

WAVEFORMATEX FormatPcm() {
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = KANALY;
    fmt.nSamplesPerSec = CZESTOTLIWOSC;
    fmt.wBitsPerSample = BITY;
    fmt.nBlockAlign = BLOK;
    fmt.nAvgBytesPerSec = CZESTOTLIWOSC * BLOK;
    return fmt;
}

// ActivateAudioInterfaceAsync jest asynchroniczne — handler budzi nasz event.
class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
public:
    HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HRESULT status = E_FAIL;
    IAudioClient* client = nullptr;

    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT hr = S_OK;
        IUnknown* unk = nullptr;
        op->GetActivateResult(&hr, &unk);
        status = hr;
        if (SUCCEEDED(hr) && unk) unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
        if (unk) unk->Release();
        SetEvent(done);
        return S_OK;
    }

    ~ActivationHandler() override {
        if (done) CloseHandle(done);
    }
};

}  // namespace

class AudioCapture : public Napi::ObjectWrap<AudioCapture> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit AudioCapture(const Napi::CallbackInfo& info);
    ~AudioCapture() override;

private:
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);

    void Petla();
    HRESULT Otworz(IAudioClient** client, IAudioCaptureClient** capture, HANDLE* audioEvent);
    void Zatrzymaj();

    DWORD pid_ = 0;
    std::thread worker_;
    HANDLE stopEvent_ = nullptr;
    Napi::ThreadSafeFunction tsfn_;

    // Sygnal z watku roboczego: "strumien otwarty albo aktywacja padla".
    std::mutex startMutex_;
    std::condition_variable startCv_;
    bool startDone_ = false;
    HRESULT startHr_ = E_FAIL;
};

AudioCapture::AudioCapture(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AudioCapture>(info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "PID musi byc liczba").ThrowAsJavaScriptException();
        return;
    }
    pid_ = info[0].As<Napi::Number>().Uint32Value();

    // Windows aktywuje loopback dla nieistniejacego procesu BEZ bledu i podaje
    // cisze w nieskonczonosc. Sprawdzamy wiec sami, zeby zle mapowanie okna na
    // PID bylo glosnym wyjatkiem, a nie niemym streamem.
    HANDLE proces = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid_);
    if (proces) {
        CloseHandle(proces);
    } else if (GetLastError() == ERROR_INVALID_PARAMETER) {
        // Tylko ten kod oznacza "nie ma takiego PID-u". ACCESS_DENIED znaczy,
        // ze proces istnieje, ale nalezy do kogos innego — to nie jest powod
        // do odmowy, bo loopback i tak zadziala.
        char komunikat[96];
        snprintf(komunikat, sizeof(komunikat), "Proces %lu nie istnieje",
                 (unsigned long)pid_);
        Napi::Error::New(env, komunikat).ThrowAsJavaScriptException();
        return;
    }
}

AudioCapture::~AudioCapture() {
    Zatrzymaj();
}

HRESULT AudioCapture::Otworz(IAudioClient** client, IAudioCaptureClient** capture,
                             HANDLE* audioEvent) {
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid_;
    // TREE: lapiemy tez procesy potomne — przegladarki i gry rozdzielaja audio
    // na osobne procesy renderujace.
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = (BYTE*)&params;

    auto handler = Make<ActivationHandler>();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                             __uuidof(IAudioClient), &pv, handler.Get(), &op);
    if (op) op->Release();
    if (FAILED(hr)) return hr;

    if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) {
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    if (FAILED(handler->status)) return handler->status;
    if (!handler->client) return E_NOINTERFACE;

    *client = handler->client;
    handler->client = nullptr;  // wlasnosc przechodzi na nas

    WAVEFORMATEX fmt = FormatPcm();
    hr = (*client)->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        10000000, 0, &fmt, nullptr);
    if (FAILED(hr)) return hr;

    *audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = (*client)->SetEventHandle(*audioEvent);
    if (FAILED(hr)) return hr;

    hr = (*client)->GetService(__uuidof(IAudioCaptureClient), (void**)capture);
    if (FAILED(hr)) return hr;

    return (*client)->Start();
}

void AudioCapture::Petla() {
    HRESULT hrCom = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comNasze = SUCCEEDED(hrCom);

    IAudioClient* client = nullptr;
    IAudioCaptureClient* capture = nullptr;
    HANDLE audioEvent = nullptr;

    HRESULT hr = Otworz(&client, &capture, &audioEvent);

    {
        std::lock_guard<std::mutex> lock(startMutex_);
        startHr_ = hr;
        startDone_ = true;
    }
    startCv_.notify_one();

    if (SUCCEEDED(hr)) {
        HANDLE czekaj[2] = {stopEvent_, audioEvent};
        for (;;) {
            DWORD w = WaitForMultipleObjects(2, czekaj, FALSE, 200);
            if (w == WAIT_OBJECT_0) break;  // stopEvent_

            UINT32 dostepne = 0;
            while (SUCCEEDED(capture->GetNextPacketSize(&dostepne)) && dostepne > 0) {
                BYTE* dane = nullptr;
                UINT32 ramek = 0;
                DWORD flagi = 0;
                if (FAILED(capture->GetBuffer(&dane, &ramek, &flagi, nullptr, nullptr))) break;

                const size_t bajtow = (size_t)ramek * BLOK;
                auto* kopia = new std::vector<uint8_t>(bajtow);
                // Bufor WASAPI przestaje byc nasz po ReleaseBuffer, wiec kopiujemy.
                // Przy fladze SILENT sterownik nie wypelnia bufora — sami dajemy zera.
                if (!(flagi & AUDCLNT_BUFFERFLAGS_SILENT) && dane) {
                    memcpy(kopia->data(), dane, bajtow);
                }
                capture->ReleaseBuffer(ramek);

                tsfn_.BlockingCall(
                    kopia, [](Napi::Env env, Napi::Function cb, std::vector<uint8_t>* buf) {
                        // Buffer::Copy, a NIE Buffer::New ze wskaznikiem zewnetrznym.
                        // Electron ma wlaczona klatke pamieci V8 i odrzuca zewnetrzne
                        // bufory ("External buffers are not allowed") — callback rzucal
                        // wyjatek ~100 razy na sekunde, a do JS nie trafial ani jeden
                        // pakiet. W samym Node dziala jedno i drugie, wiec testy vitest
                        // tego NIE wylapia. Straznikiem jest check/electron.js.
                        cb.Call({Napi::Buffer<uint8_t>::Copy(env, buf->data(), buf->size())});
                        delete buf;
                    });
            }
        }
        client->Stop();
    }

    if (capture) capture->Release();
    if (client) client->Release();
    if (audioEvent) CloseHandle(audioEvent);
    if (comNasze) CoUninitialize();

    tsfn_.Release();
}

Napi::Value AudioCapture::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // stopEvent_ istnieje dokladnie wtedy, gdy watek roboczy zyje. Bez tej
    // blokady drugi start() przypisalby do zyjacego std::thread, co w C++
    // konczy sie std::terminate — proces ginie bez zadnego komunikatu.
    if (stopEvent_) {
        Napi::Error::New(env, "Przechwytywanie juz trwa").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "start() wymaga funkcji zwrotnej")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);  // reczny reset
    startDone_ = false;
    startHr_ = E_FAIL;

    tsfn_ = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                          "ts3-audio-capture", 0, 1);
    worker_ = std::thread(&AudioCapture::Petla, this);

    HRESULT hr;
    {
        std::unique_lock<std::mutex> lock(startMutex_);
        startCv_.wait_for(lock, std::chrono::seconds(10), [this] { return startDone_; });
        hr = startHr_;
    }

    if (FAILED(hr)) {
        Zatrzymaj();
        char komunikat[192];
        snprintf(komunikat, sizeof(komunikat),
                 "Nie udalo sie otworzyc dzwieku procesu %lu (HRESULT 0x%08lX)",
                 (unsigned long)pid_, (unsigned long)hr);
        Napi::Error::New(env, komunikat).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return env.Undefined();
}

void AudioCapture::Zatrzymaj() {
    if (stopEvent_) SetEvent(stopEvent_);
    if (worker_.joinable()) worker_.join();
    if (stopEvent_) {
        CloseHandle(stopEvent_);
        stopEvent_ = nullptr;
    }
}

Napi::Value AudioCapture::Stop(const Napi::CallbackInfo& info) {
    Zatrzymaj();
    return info.Env().Undefined();
}

Napi::Object AudioCapture::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function ctor = DefineClass(env, "AudioCapture",
                                      {
                                          InstanceMethod("start", &AudioCapture::Start),
                                          InstanceMethod("stop", &AudioCapture::Stop),
                                      });
    exports.Set("AudioCapture", ctor);

    // Format podajemy z C++, zeby byl jedno zrodlo prawdy. Renderer buduje
    // z tego AudioBuffer i nie moze zgadywac czestotliwosci.
    Napi::Object format = Napi::Object::New(env);
    format.Set("sampleRate", Napi::Number::New(env, CZESTOTLIWOSC));
    format.Set("channels", Napi::Number::New(env, KANALY));
    format.Set("bytesPerSample", Napi::Number::New(env, BITY / 8));
    format.Set("encoding", Napi::String::New(env, "float32"));
    exports.Set("FORMAT", format);

    return exports;
}

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
    return AudioCapture::Init(env, exports);
}

NODE_API_MODULE(audio_capture, InitAll)
