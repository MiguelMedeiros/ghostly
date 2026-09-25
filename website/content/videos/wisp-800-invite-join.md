---
wisp: "800"
slug: "800-invite-join"
title: "Invite and Join"
availability: released
duration: "~4:20"
status: script
---

# WISP 800: Invite and Join (example lesson)

A representative script. Availability checked against the code on 2026-09-23:
invite links are in the public release (v0.4.0); paired invitations with a
scannable QR code are in development for 0.5.0.

## 1. Opening (0:00-0:12)

Picture: the homepage hero, Boo alone, looking around. Title card "WISP 800 · Invite and Join".

Narration (EN): "Every conversation in Ghostly starts with an invitation. This is WISP 800: how an invitation turns into a connection both people agreed to."

Narração (PT): "Toda conversa no Ghostly começa com um convite. Este é o WISP 800: como um convite vira uma conexão que as duas pessoas aceitaram."

## 2. Problem (0:12-0:50)

Picture: scene 01 of the homepage (the invitation card appears, travels to Casper).

Narration (EN): "Most apps start with an account: a phone number, an email, a public profile. Ghostly doesn't. So how do two people find each other? One of them makes an invitation for exactly one person, and shares it however they like: in person, by message, on paper."

Narração (PT): "A maioria dos apps começa com uma conta: telefone, e-mail, perfil público. O Ghostly não. Então como duas pessoas se acham? Uma delas cria um convite para exatamente uma pessoa e compartilha como quiser: pessoalmente, por mensagem, no papel."

## 3. The piece (0:50-1:50)

Picture: `/developers#compose`, "A minimal client" preset; select the Invitations block.

Narration (EN): "The invitation is its own contract. It says what an invitation must carry, how the other side joins, and how both sides admit the connection. It does not say which transport you'll use, or what you'll do afterwards. Those are other pieces. A minimal client needs just five: the core, keys, invitations, one transport and chat."

Narração (PT): "O convite é um contrato próprio. Ele diz o que um convite precisa levar, como o outro lado entra e como os dois lados admitem a conexão. Ele não diz qual transporte você vai usar, nem o que vai fazer depois. Isso fica para outras peças. Um cliente mínimo precisa de só cinco: o núcleo, as chaves, os convites, um transporte e o chat."

## 4. In the app (1:50-3:00)

Recording: two web clients side by side (development build, paired chats), then the same flow with an invite link on v0.4.0.

- Boo: New → invite card with QR and "Copy invite".
- Casper: Join → paste (or scan) → connected; both see "joined the chat".
- Say on screen: "QR scanning: development build (0.5.0)".

Narration (EN): "In the app it's one button. Boo creates an invitation, here as a QR code and a link. Casper joins, and both apps confirm the connection. In the public release you share a link; scanning a QR code with the camera arrives in the next release."

Narração (PT): "No app é um botão. O Boo cria um convite, aqui como QR code e link. O Casper entra, e os dois apps confirmam a conexão. Na versão pública você compartilha um link; escanear um QR code com a câmera chega na próxima versão."

## 5. How it works (3:00-4:10)

Picture: WISP 801 in the reader, then the `createLink` snippet from `/developers#path`.

Narration (EN): "Under the hood, an invitation carries three things: a seed for the key you will use on this link, the other side's public key, and a shared key for this link only. Both ends are created at once. You keep one, you hand over the other. Paired invitations add a prefix: pair1 for a live connection, pair2d for DHT-only text. Nothing here identifies you outside this conversation."

Narração (PT): "Por dentro, um convite leva três coisas: uma semente para a chave que você vai usar neste link, a chave pública do outro lado e uma chave compartilhada só deste link. As duas pontas nascem juntas: você fica com uma e entrega a outra. Convites pareados ganham um prefixo: pair1 para conexão ao vivo, pair2d para texto só pela DHT. Nada aqui identifica você fora desta conversa."

Limits to say: an invitation contains secrets. Share it only with the person you mean; whoever has it can join.

## 6. Next step (4:10-4:20)

End card: `ghostly.tools/developers/wisps/800-invite-join` · `packages/core/src/invite.ts` · next: WISP 01 Ghost Core.

Narration (EN): "Read WISP 800 and 801 on the site, and the code in packages/core. Next lesson: how the two apps actually find each other on the DHT."

Narração (PT): "Leia os WISPs 800 e 801 no site, e o código em packages/core. Próxima aula: como os dois apps realmente se encontram na DHT."

## Social cuts

- 30 s: Opening + Problem + end card.
- 60 s: Opening + In the app + end card.
