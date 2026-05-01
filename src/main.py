from dataclasses import field
import asyncio
import os

import flet as ft
import flet_video as ftv


@ft.control
class CalcButton(ft.Button):
    expand: int = field(default_factory=lambda: 1)


@ft.control
class DigitButton(CalcButton):
    bgcolor: ft.Colors = ft.Colors.WHITE_24
    color: ft.Colors = ft.Colors.WHITE


@ft.control
class ActionButton(CalcButton):
    bgcolor: ft.Colors = ft.Colors.ORANGE
    color: ft.Colors = ft.Colors.WHITE


@ft.control
class ExtraActionButton(CalcButton):
    bgcolor: ft.Colors = ft.Colors.BLUE_GREY_100
    color: ft.Colors = ft.Colors.BLACK


class FileManagement(ft.Container):
    def __init__(self, file_picker: ft.FilePicker, video_player, **kwargs):
        super().__init__(**kwargs)
        self.file_picker = file_picker
        self.video_player = video_player

    def init(self):
        self.expand = 1
        self.bgcolor = ft.Colors.BLACK
        self.border_radius = ft.BorderRadius.all(20)
        self.padding = 20

        self.selected_path = ft.Text(value="No folder selected", color=ft.Colors.WHITE_70)
        self.selected_file = ft.Text(value="No file selected", color=ft.Colors.WHITE_70)
        self.files_column = ft.Column(expand=True, scroll=ft.ScrollMode.AUTO)

        select_button = ft.Button("Select Folder", on_click=self._on_select_folder)

        self.content = ft.Column(
            controls=[
                ft.Text(value="File Management", color=ft.Colors.WHITE, size=20),
                ft.Row(controls=[select_button, self.selected_path]),
                self.selected_file,
                ft.Divider(height=10),
                self.files_column,
            ]
        )

    async def _on_select_folder(self, e):
        path = await self.file_picker.get_directory_path(dialog_title="Select folder")
        if not path:
            return

        await self.load_folder(path)

    async def load_folder(self, path: str):
        # update selected path text
        self.selected_path.value = path

        # list files in selected folder
        try:
            entries = sorted(os.listdir(path))
        except Exception as exc:
            self.files_column.controls = [ft.Text(f"Error reading folder: {exc}", color=ft.Colors.RED)]
            self.update()
            return

        controls = []
        for name in entries:
            full = os.path.join(path, name)
            if os.path.isdir(full):
                controls.append(ft.Row(controls=[ft.Icon(ft.Icons.FOLDER), ft.Text(name, color=ft.Colors.WHITE)]))
            else:
                controls.append(self._build_file_button(name, full))

        self.files_column.controls = controls
        self.update()

    def _video_extensions(self):
        return {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv"}

    def _build_file_button(self, name: str, full_path: str):
        return ft.Button(
            name,
            icon=ft.Icons.FILE_OPEN,
            on_click=lambda e, file_path=full_path: asyncio.create_task(
                self._on_file_selected(file_path)
            ),
        )

    async def _on_file_selected(self, file_path: str):
        self.selected_file.value = file_path

        extension = os.path.splitext(file_path)[1].lower()
        if extension in self._video_extensions():
            await self.video_player.open_video(file_path)
        else:
            self.video_player.show_message(
                f"Selected file is not a supported video: {os.path.basename(file_path)}"
            )

        self.update()

class VideoPlayer(ft.Container):
    def init(self):
        self.expand = 1
        self.bgcolor = ft.Colors.BLACK
        self.border_radius = ft.BorderRadius.all(20)
        self.padding = 20

        self.status_text = ft.Text(value="No video selected", color=ft.Colors.WHITE_70)
        self.video = ftv.Video(
            expand=True,
            visible=False,
            autoplay=True,
            show_controls=True,
            fit=ft.BoxFit.CONTAIN,
            fill_color=ft.Colors.BLACK,
        )

        self.content = ft.Column(
            controls=[
                ft.Text(value="Video Player", color=ft.Colors.WHITE, size=20),
                self.status_text,
                self.video,
            ]
        )

    async def open_video(self, file_path: str):
        self.status_text.value = os.path.basename(file_path)
        try:
            await self.video.stop()
        except Exception:
            pass

        self.video.playlist = [ftv.VideoMedia(file_path)]
        self.video.visible = True
        self.update()
        await self.video.play()

    def show_message(self, message: str):
        self.status_text.value = message
        self.video.playlist = []
        self.video.visible = False
        self.update()

def main(page: ft.Page):
    page.title = "Eye Data Manipulation System"
    file_picker = None

    video_player = VideoPlayer()
    file_management = FileManagement(file_picker=file_picker, video_player=video_player)

    async def start_new_project():
        nonlocal file_picker
        if file_picker is None:
            file_picker = ft.FilePicker()
            file_management.file_picker = file_picker

        path = await file_picker.get_directory_path(dialog_title="Select project folder")
        if not path:
            return

        page.controls.clear()
        page.add(ft.Row(expand=True, controls=[file_management, video_player]))
        page.update()

        await file_management.load_folder(path)

    def open_existing_project(e):
        page.snack_bar = ft.SnackBar(ft.Text("Open existing project is not implemented yet."))
        page.snack_bar.open = True
        page.update()

    landing = ft.Container(
        expand=True,
        padding=40,
        content=ft.Column(
            alignment=ft.MainAxisAlignment.CENTER,
            horizontal_alignment=ft.CrossAxisAlignment.CENTER,
            controls=[
                ft.Text("Welcome", size=32, weight=ft.FontWeight.BOLD),
                ft.Text("Choose how you want to start.", color=ft.Colors.BLACK_54),
                ft.Container(height=10),
                ft.Row(
                    alignment=ft.MainAxisAlignment.CENTER,
                    controls=[
                        ft.Button(
                            "Create new project",
                            on_click=lambda e: asyncio.create_task(start_new_project()),
                        ),
                        ft.Button("Open existing project", on_click=open_existing_project),
                    ],
                ),
            ],
        ),
    )

    page.add(landing)


ft.run(main)