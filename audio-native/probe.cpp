// Probe: czy Windows Process Loopback API realnie przechwytuje dzwiek
// z WYBRANEGO procesu (a nie calego systemu).
//
// Uzycie:  probe.exe <PID> [sekundy]
//
// Celowo minimalny: sprawdzamy TYLKO czy da sie otworzyc strumien i czy
// przychodza probki niezerowe. Dopiero pozytywny wynik uzasadnia pisanie
// pelnego modulu natywnego.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>
#include <cstdio>
#include <cmath>

using namespace Microsoft::WRL;

// ActivateAudioInterfaceAsync jest asynchroniczne — handler budzi nasz event.
class Handler : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                                    FtmBase,
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
};

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) { wprintf(L"PROBE uzycie: probe.exe <PID> [sekundy]\n"); return 2; }
    DWORD pid = _wtoi(argv[1]);
    int sekundy = (argc > 2) ? _wtoi(argv[2]) : 5;

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    // TREE: lapiemy tez procesy potomne — przegladarki i gry rozdzielaja audio
    // na osobne procesy renderujace.
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = (BYTE*)&params;

    auto handler = Make<Handler>();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op);
    if (FAILED(hr)) { wprintf(L"PROBE ActivateAudioInterfaceAsync -> 0x%08X\n", hr); return 1; }

    WaitForSingleObject(handler->done, 5000);
    if (FAILED(handler->status) || !handler->client) {
        wprintf(L"PROBE aktywacja NIEUDANA -> 0x%08X\n", handler->status);
        return 1;
    }
    wprintf(L"PROBE aktywacja OK dla PID %u\n", pid);

    // Process loopback NIE wspiera GetMixFormat — format trzeba podac wprost.
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = 2;
    fmt.nSamplesPerSec = 48000;
    fmt.wBitsPerSample = 32;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

    hr = handler->client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                     AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                     10000000, 0, &fmt, nullptr);
    if (FAILED(hr)) { wprintf(L"PROBE Initialize -> 0x%08X\n", hr); return 1; }

    HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    handler->client->SetEventHandle(ev);

    IAudioCaptureClient* capture = nullptr;
    hr = handler->client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
    if (FAILED(hr)) { wprintf(L"PROBE GetService -> 0x%08X\n", hr); return 1; }

    handler->client->Start();
    wprintf(L"PROBE nasluchuje %d s...\n", sekundy);

    UINT64 ramek = 0, niezerowych = 0;
    double szczyt = 0.0;
    ULONGLONG koniec = GetTickCount64() + (ULONGLONG)sekundy * 1000;

    while (GetTickCount64() < koniec) {
        if (WaitForSingleObject(ev, 500) != WAIT_OBJECT_0) continue;
        UINT32 dostepne = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&dostepne)) && dostepne > 0) {
            BYTE* dane = nullptr; UINT32 ile = 0; DWORD flagi = 0;
            if (FAILED(capture->GetBuffer(&dane, &ile, &flagi, nullptr, nullptr))) break;
            if (!(flagi & AUDCLNT_BUFFERFLAGS_SILENT) && dane) {
                float* probki = (float*)dane;
                for (UINT32 i = 0; i < ile * fmt.nChannels; i++) {
                    double v = fabs(probki[i]);
                    if (v > 0.0001) niezerowych++;
                    if (v > szczyt) szczyt = v;
                }
            }
            ramek += ile;
            capture->ReleaseBuffer(ile);
        }
    }

    handler->client->Stop();
    wprintf(L"PROBE ramek=%llu niezerowych_probek=%llu szczyt=%.4f\n", ramek, niezerowych, szczyt);
    wprintf(L"PROBE WYNIK: %s\n",
            (ramek > 0 && niezerowych > 0) ? L"DZWIEK PRZECHWYCONY"
            : (ramek > 0 ? L"strumien dziala, ale cisza (czy ta aplikacja gra?)"
                         : L"brak danych"));

    capture->Release();
    handler->client->Release();
    CoUninitialize();
    return 0;
}
