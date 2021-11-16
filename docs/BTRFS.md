---
sidebarDepth: 3
---

<!-- ---
lang: en-US
title: Title of this page
description: Description of this page
--- -->

# The ideal BTRFS setup on Arch Linux

In this post, I'll describe how I managed to fix some problems with my encrypted BTRFS (with snapper) setup in Arch Linux after some hit and trial. Although the venerable [Arch Wiki](https://wiki.archlinux.org) has most of the information presented here, it had some missing pieces and the information in the wiki is scattered over many entries. I've tried to compile everything into one cohesive piece here.

This post assumes you are already familiar with, and are (or will be) using:

-   btrfs
-   cryptsetup (LUKS2)
-   UEFI
-   snapper
-   grub
-   Arch btw :wink:

::: tip NOTE
GRUB, because only GRUB has support for this workflow. Check comparison table [here](https://wiki.archlinux.org/title/Arch_boot_process#Feature_comparison).
:::

## The problem

Until now, I was mounting the ESP (_EFI System Partition_) to `/boot`, which is quite common in Arch Linux. But this has some drawbacks:

1. Each snapshot of the root subvolume wouldn't have its own copy of the kernel and initrd images (which are located inside `/boot`). This means that there is no guarantee that you will be able to boot a snapshot from a month ago, if your current kernel/initrd is not the same as the kernel/initrd that was being used when the snapshot was taken, especially if you've made significant changes to `/etc/mkinitcpio.conf`.

1. If your system becomes unbootable after an upgrade due to a problem with the kernel, then you won't be able to boot an otherwise perfectly working old snapshot of your system.

1. If you want to maintain a twin system (while having the ability to modify the twin without worrying about messing up your main system), then the two systems should not share anything, including the kernels and initrd images.

## The solution

We simply need to keep `/boot` as a simple directory in the subvolume mounted at `/` i.e. don't mount anything to `/boot`. This will ensure that each snapshot has its own copy of the contents of `/boot` and wouldn't be sharing the same exact `/boot`, which they otherwise do when the ESP is mounted at `/boot`.

But for this to work, the EFI bootloader in the ESP needs to be able to read the kernel and initrd images from the BTRFS partition. Additionally, if the BTRFS partition is encrypted, then it will have to unlock the encrypted partition first and then read the BTRFS partition inside it.

Currently, only one bootloader has this capability: GRUB. ([See here](https://wiki.archlinux.org/title/Arch_boot_process#Feature_comparison))

## Step-by-Step Guide

### EFI System Partition (ESP) setup

We need to mount the ESP to `/efi` instead of `/boot`.

1. Edit `/etc/fstab` and change the mount point of the ESP for `/boot` to `/efi`.

1. Unmount the ESP currently mounted at `/boot` and mount it to `/efi`, like this:

```bash
$ sudo umount /boot
$ sudo mkdir /efi
$ sudo mount /efi
```

At this point, your `/boot` directory should be empty. To populate it with the kernel and initrd images, reinstall the `linux` package (or whatever kernel you use) and the [microcode](https://wiki.archlinux.org/title/Microcode) package, like this:

```bash
$ sudo pacman -S linux intel-ucode #use amd-ucode for AMD CPU
```

`/boot` should look something like this now:

```bash
$ ls /boot
initramfs-linux-fallback.img  initramfs-linux.img  intel-ucode.img  vmlinuz-linux
```

::: tip
You should clean up the old version of these files now present in `/efi` only after going through this entire post and verifying that everything works.
:::

If you were using the `50-bootbackup.hook` pacman hook [described in the Arch Wiki](https://wiki.archlinux.org/title/Snapper#Backup_non-Btrfs_boot_partition_on_pacman_transactions), you no longer need it, and you should remove it:

```bash
$ sudo rm /etc/pacman.d/hooks/50-bootbackup.hook
```

Instead, you might want to back up the ESP mounted to `/efi`. The procedure for doing so is described next.

#### Backup `/efi` (OPTIONAL)

Because the ESP is outside BTRFS, its content will not be part of snapshots. To keep a synced copy inside BTRFS root subvolume (in `/.esp.backup`), use the following systemd units (you need both the files):

---

`/etc/systemd/system/espbackup.path`

```ini
[Unit]
Description=Monitors for changes in ESP
DefaultDependencies=no
After=efi.mount
BindsTo=efi.mount

[Path]
PathModified=/efi

[Install]
WantedBy=efi.mount
```

::: tip NOTE
Replace `efi.mount` with the name of the systemd service that mounts `/efi`. Run `systemctl list-units -t mount` to find out.
:::

---

`/etc/systemd/system/espbackup.service`

```ini
[Unit]
Description=Sync ESP

[Service]
Type=oneshot
# Set the possible paths for `rsync`
Environment="PATH=/sbin:/bin:/usr/sbin:/usr/bin"
# Sync directories
ExecStart=rsync -a --delete /efi/ /.efi.backup
```

---

Now, enable and start it with:

```bash
$ sudo systemctl enable --now espbackup.path
```

### LUKS2 setup

::: danger WARNING
If the header of a LUKS encrypted partition gets destroyed, you will not be able to decrypt your data. Before proceeding with this section, make sure that you back up the header of your current LUKS partition and store it in a safe location (which must be _outside_ that encrypted partition itself, obviously). [Consult the Arch Wiki for this](https://wiki.archlinux.org/title/Dm-crypt/Device_encryption#Backup_using_cryptsetup).
:::

If `/dev/sdXN` is your LUKS2 partition, check current keyslots with:

```bash
$ sudo cryptsetup luksDump /dev/sdXN
```

Note which keyslot is being used. If the PBKDF of your current key is not `pbkdf2`, then you have to convert it to `pbkdf2` because in the current version of GRUB, [only the `pbkdf2` key derival function is supported](https://git.savannah.gnu.org/cgit/grub.git/commit/?id=365e0cc3e7e44151c14dd29514c2f870b49f9755).

The PBKDF algorithm can be changed for the existing key with (replace _N_ with the actual keyslot number, and `/dev/sdXN` with your LUKS2 partition):

```bash
$ sudo cryptsetup luksConvertKey --key-slot N --pbkdf pbkdf2 /dev/sdXN
```

::: tip NOTE
The decryption of GRUB is quite slow. You can make it faster by changing the `iter-time` parameter of the key. Just add `--iter-time XXXX` to the command above.

See [here](https://unix.stackexchange.com/questions/369414/grub-takes-too-long-to-unlock-the-encrypted-boot-partition) for more info. I used a value of `500` (default is `2000`), but do your own research on this, because reducing the `iter-time` will reduce security.
:::

::: tip NOTE
After verifying that everything works, you might want to create another backup of your new LUKS header
:::

#### Avoid entering passphrase twice (OPTIONAL)

You will be prompted twice for a passphrase: first, for GRUB to unlock and access `/boot` in early boot, and second, to unlock the root filesystem itself as implemented by the initramfs. You can use a keyfile to avoid this.

Do the following to generate a keyfile, give it suitable permissions and add it as a LUKS key:

```bash
$ sudo dd bs=512 count=4 if=/dev/random of=/crypto_keyfile.bin iflag=fullblock
$ sudo chmod 600 /crypto_keyfile.bin
$ sudo chmod 600 /boot/initramfs-linux*
$ sudo cryptsetup luksAddKey /dev/sdXN /crypto_keyfile.bin
```

where `/dev/sdXN` is your LUKS2 partition.

::: warning
If you're using the `encrypt` hook in `/etc/mkinitcpio.conf`, the keyfile must be named and located _exactly_ in `/crypto_keyfile.bin`, otherwise you will need extra configuration.

If you're using `sd-encrypt` instead, consult the Arch Wiki about configuring the keyfile, because I've never tried `sd-encrypt`.
:::

([Source: Arch Wiki](https://wiki.archlinux.org/title/Dm-crypt/Device_encryption#With_a_keyfile_embedded_in_the_initramfs))

Include the key in `/etc/mkinitcpio.conf`'s `FILES` array:

```
FILES=(/crypto_keyfile.bin)
```

Regenerate the initramfs:

```bash
$ sudo mkinitcpio -P
```

::: tip NOTE
The keyfile doesn't need to be `pbkdf2`
:::

### GRUB setup

Install the [`grub`](https://archlinux.org/packages/core/x86_64/grub/) package if not already installed:

```bash
$ sudo pacman -S grub
```

Edit `/etc/default/grub` and add `luks2` to `GRUB_PRELOAD_MODULES`, like this:

```
GRUB_PRELOAD_MODULES="part_gpt part_msdos luks2"
```

Edit the other configurations in `/etc/default/grub` as you normally do.

Create the file `/etc/grub.d/01_header` with the following content:

```bash
#! /bin/sh

# replace d36b433dfce44d91b7cef4f37c2a3bdd with UUID of your LUKS2 partition
echo "cryptomount -u d36b433dfce44d91b7cef4f37c2a3bdd"
```

::: tip NOTE
If the UUID of your LUKS2 partition is `d36b433d-fce4-4d91-b7ce-f4f37c2a3bdd`, you should remove the dashes, like this: `d36b433dfce44d91b7cef4f37c2a3bdd`. ([Source](https://www.gnu.org/software/grub/manual/grub/html_node/cryptomount.html#cryptomount)).
:::

(This is much simpler than the process described [here](https://wiki.archlinux.org/title/GRUB#LUKS2) in the Arch Wiki.)

Now register GRUB in the ESP:

```bash
$ sudo grub-install --target=x86_64-efi --efi-directory=/efi --boot-directory=/efi --bootloader-id=GRUB
```

The command above should create:

-   the file `/efi/EFI/GRUB/grubx64.efi`
-   the directory `/efi/grub`
-   an entry in the UEFI bootloader called `GRUB`, which you can verify by running `efibootmgr`

Finally, generate the GRUB configuration:

```bash
$ grub-mkconfig -o /efi/grub/grub.cfg
```

#### `grub-btrfs` setup

Install [`grub-btrfs`](https://archlinux.org/packages/community/any/grub-btrfs/):

```bash
$ sudo pacman -S grub-btrfs
```

The configuration file for `grub-btrfs` is `/etc/default/grub-btrfs/config`. Change the following value in `/etc/default/grub-btrfs/config`:

```
GRUB_BTRFS_GRUB_DIRNAME="/efi/grub"
```

For entries to be automatically added to the GRUB menu whenever a snapshot is made or deleted, mount your subvolume which contains snapshots to `/.snapshots` (ideally you should have an entry for this in `/etc/fstab`), and run:

```bash
$ sudo systemctl enable --now grub-btrfs.path
```

`grub-btrfs.path` is a systemd unit which automatically (re)generates `/efi/grub/grub-btrfs.cfg` whenever a modification happens in `/.snapshots`.

##### Booting read-only snapshots

> Booting on a snapshot in read-only mode can be tricky. An elegant way is to boot this snapshot using overlayfs (included in the kernel ≥ 3.18).

> Using overlayfs, the booted snapshot will behave like a live-cd in non-persistent mode. The snapshot will not be modified, the system will be able to boot correctly, because a writeable folder will be included in the ram.

([Source](https://github.com/Antynea/grub-btrfs/blob/master/initramfs/readme.md))

Edit `/etc/mkinitcpio.conf` and add the hook `grub-btrfs-overlayfs` at the end of the line `HOOKS`. For example:

```
HOOKS=(base udev autodetect modconf block filesystems keyboard fsck grub-btrfs-overlayfs)
```

::: danger WARNING
Do not copy-paste the above line. You should only add `grub-btrfs-overlayfs` to the pre-existing line in the file.
:::

Finally regenerate the initramfs.

```bash
$ sudo mkinitcpio -P
```

## Conclusion

If everything works as intended after rebooting, you should delete the following files:

```
/efi/initramfs-linux-fallback.img
/efi/initramfs-linux.img
/efi/intel-ucode.img
/efi/vmlinuz-linux
```

Now the ESP (mounted to `/efi`) should look something like this:

```
/efi
├── EFI
│   ├── BOOT
│   │   └── BOOTX64.EFI
│   └── GRUB
│       └── grubx64.efi
└── grub
    ├── fonts
    ├── grub-btrfs.cfg
    ├── grub.cfg
    ├── grubenv
    ├── locale
    ├── themes
    └── x86_64-efi
```

Quite clean :sparkles:, eh?

You can verify that each snapshot is using its own copy of the kernel and initrd images by inspecting the entries generated in `/efi/grub/grub-btrfs.cfg`. Notice the lines starting with `linux` and `initrd` for the various entries, and you will observe that each entry is using its own `/boot` directory for booting.

In the future, I'll describe how I can now effortlessly create and manage a twin system with this setup. Thanks for reading!
