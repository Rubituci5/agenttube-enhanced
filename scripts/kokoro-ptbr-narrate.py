#!/usr/bin/env python3
"""Local neural pt-BR narration for IAgora. No API calls or paid TTS."""
import json, os, re, subprocess, sys, time
from pathlib import Path
import numpy as np
import soundfile as sf
from misaki.espeak import EspeakG2P
from kokoro_onnx import Kokoro

ROOT=Path(__file__).resolve().parents[1]
KOKORO=ROOT/'data/models/kokoro'
VOICE='pm_alex'
ID='prod_1791776974066_fxfxwh7olvf_f4cfkmbgwvp'
INPUT=ROOT/'temp/processing/godzilla-kokoro-scenes.json'
DEST=ROOT/'data/audio/scenes'/ID
FFMPEG=ROOT/'node_modules/ffmpeg-static/ffmpeg'
os.environ['ORT_LOG_SEVERITY_LEVEL']='3'

def chunks(text,max_size=180):
    text=re.sub(r'\s+',' ',text).strip()
    pieces=re.split(r'(?<=[.!?;:])\s+',text)
    out=[]
    acc=''
    for sentence in pieces:
        if len(acc)+len(sentence)+1<=max_size:
            acc=f'{acc} {sentence}'.strip()
        else:
            if acc:out.append(acc)
            acc=''
            if len(sentence)>max_size:
                words=sentence.split()
                part=''
                for word in words:
                    if len(part)+len(word)+1>max_size:
                        if part:out.append(part)
                        part=word
                    else:part=f'{part} {word}'.strip()
                acc=part
            else:acc=sentence
    if acc:out.append(acc)
    return out

def main():
    src=json.loads(INPUT.read_text('utf-8'))
    assert len(src['scenes'])==9
    DEST.mkdir(parents=True,exist_ok=True)
    g2p=EspeakG2P(language='pt-br')
    start=time.monotonic()
    synth=Kokoro(str(KOKORO/'kokoro-v1.0.fp16.onnx'),str(KOKORO/'voices-v1.0.bin'))
    if VOICE not in synth.get_voices():raise ValueError('Voice pm_alex is unavailable')
    result=[]
    for idx,scene in enumerate(src['scenes']):
        target=DEST/f'{idx:03d}_kokoro_pm_alex.mp3'
        if target.exists() and target.stat().st_size>5000:
            print('VOICE_CACHED',idx+1,target.stat().st_size,flush=True)
        else:
            sample_list=[]
            for segment in chunks(scene['scriptText']):
                phonemes,_=g2p(segment)
                if not phonemes:continue
                samples,sample_rate=synth.create(phonemes,VOICE,is_phonemes=True,speed=1.04)
                if len(samples)==0:continue
                sample_list.append(np.asarray(samples,dtype=np.float32))
                sample_list.append(np.zeros(int(sample_rate*.16),dtype=np.float32))
            if not sample_list:raise RuntimeError('Sem áudio gerado para cena '+str(idx+1))
            wave=DEST/f'{idx:03d}_kokoro_temp.wav'
            sf.write(wave,np.concatenate(sample_list),sample_rate,subtype='PCM_16')
            try:
                subprocess.run([str(FFMPEG),'-y','-hide_banner','-loglevel','error',
                  '-i',str(wave),'-ac','1','-ar','24000','-b:a','96k',str(target)],
                  check=True,timeout=120)
            finally:wave.unlink(missing_ok=True)
            print('KOKORO_SCENE_READY',idx+1,scene['label'],
                  'bytes',target.stat().st_size,
                  'elapsed',round(time.monotonic()-start,1),flush=True)
        result.append({'sceneId':scene['id'],'path':str(target)})
        (DEST/'kokoro_manifest.json').write_text(json.dumps({
          'voice':VOICE,'provider':'kokoro-local','sources':result,
          'generatedAt':time.time()},ensure_ascii=False,indent=2),'utf8')
    print('KOKORO_COMPLETE',len(result),round(time.monotonic()-start,1),flush=True)

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('KOKORO_FAILED',type(e).__name__,str(e)[:260],flush=True)
        sys.exit(1)
