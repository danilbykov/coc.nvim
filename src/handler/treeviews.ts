import { NeovimClient as Neovim, Tabpage, Window } from '@chemzqm/neovim'
import { TextDocument, Position } from 'vscode-languageserver-types'
import languages from '../languages'
import { WorkspaceConfiguration } from '../types'
import workspace from '../workspace'
import { TreeView, TreeViewDescription } from '../tree/ui'
import { TreeModel, TreeModelUpdate } from '../provider/TreeModelManager'
import { sequence } from '../util'

interface WindowWithTree {
  window: Window
  name: string
}

export class TreeViewsManager {
  private view2treeview: Map<string, TreeView> = new Map()
  private config: WorkspaceConfiguration

  constructor(private nvim: Neovim) {
    this.config = workspace.configurations.getConfiguration("treeviews")

    this.nvim.command('highlight default TvpClass guifg=Red ctermfg=Red', true)
    this.nvim.command('highlight default TvpObject guifg=Blue ctermfg=Blue', true)
    this.nvim.command('highlight default TvpTrait guifg=Brown ctermfg=Brown', true)
    this.nvim.command('highlight default TvpMethod guifg=DarkGreen ctermfg=DarkGreen', true)
    this.nvim.command('highlight default TvpVal guifg=Cyan ctermfg=Cyan', true)
    this.nvim.command('sign define TvpClass linehl=TvpClass', true)
    this.nvim.command('sign define TvpObject linehl=TvpObject', true)
    this.nvim.command('sign define TvpTrait linehl=TvpTrait', true)
    this.nvim.command('sign define TvpMethod linehl=TvpMethod', true)
    this.nvim.command('sign define TvpVal linehl=TvpVal', true)
  }

  public async handleAction(action: string | undefined, param: string | undefined): Promise<void> {
    switch (action) {
      case undefined:
        return this.toggleAllTrees()
      case "view":
        if (param === undefined) {
          workspace.showMessage('Missing required TreeView name', 'error')
        } else {
          return this.toggleTreeView(param)
        }
      case "ToggleNode":
        return this.toggleTreeViewNode()
      case "ParentNode":
        return this.gotoParentNode()
      case "FirstSibling":
        return this.gotoFirstNode()
      case "LastSibling":
        return this.gotoLastNode()
      case "PrevSibling":
        return this.gotoPrevSibling()
      case "NextSibling":
        return this.gotoNextSibling()
      case "ExecuteCommand":
        return this.executeCommand()
    }
  }

  public async toggleAllTrees(): Promise<void> {
    const treeViews = languages.getTreeViews()
    if (!this.checkTreeViewAvailability(treeViews)) return
    const [curtab, openWindows] = await this.getOpenWindows(treeViews)
    if (openWindows.length > 0) {
      await Promise.all(openWindows.map(({window}) => window.close(true)))
      treeViews.forEach(view => curtab.setVar(view, undefined, false))
    } else {
      await this.makeTreeViewPanel()
      const viewsConfigs = this.config.get<TreeViewDescription[]>("initialViews")
      const windows = await sequence(
        treeViews
          .filter(view => viewsConfigs.find(c => c.name === view) !== undefined)
          .sort(this.viewsComparator(viewsConfigs)),
        async (viewId, idx, arr) => {
          const window = await this.assignOrCreateTreeView(curtab, viewId)
          if (idx + 1 != arr.length) await this.nvim.command('new')
          return {name: viewId, window} as WindowWithTree
        }
      )
      await this.alignWindows(windows, viewsConfigs)
    }
  }

  public async toggleTreeView(viewName: string): Promise<void> {
    const treeViews = languages.getTreeViews()
    if (!this.checkTreeViewAvailability(treeViews)) return
    if (!this.checkTreeViewExistence(treeViews, viewName)) return
    const [opened, windows] = await this.toggleTreeViewInternal(treeViews, viewName, false)
    const viewsConfigs = this.config.get<TreeViewDescription[]>("initialViews")
    if (opened) return this.alignWindows(windows, viewsConfigs)
  }

  private async toggleTreeViewInternal(
    treeViews: string[],
    viewName: string,
    onlyOpen: boolean
  ): Promise<[boolean, WindowWithTree[]]> {
    const [curtab, openWindows] = await this.getOpenWindows(treeViews)
    const mbWindow = openWindows.find(({name}) => name == viewName)
    if (mbWindow !== undefined) {
      if (!onlyOpen) {
        await mbWindow.window.close(true)
        await curtab.setVar(viewName, undefined, false)
      }
      return [false, []]
    } else if (openWindows.length != 0) {
      const window = openWindows[0].window
      await this.nvim.call('win_gotoid', window.id)
      await this.nvim.command('new')
      const newWindow = await this.assignOrCreateTreeView(curtab, viewName)
      return [true, openWindows.concat({name: viewName, window: newWindow})]
    } else {
      await this.makeTreeViewPanel()
      const newWindow = await this.assignOrCreateTreeView(curtab, viewName)
      return [true, openWindows.concat({name: viewName, window: newWindow})]
    }
  }

  public async revealDocInTreeView(
    viewName: string,
    textDocument: TextDocument,
    position: Position
  ): Promise<void> {
    const treeViews = languages.getTreeViews()
    if (!this.checkTreeViewAvailability(treeViews)) return
    if (!this.checkTreeViewExistence(treeViews, viewName)) return
    const [opened, windows] = await this.toggleTreeViewInternal(treeViews, viewName, true)
    const viewsConfigs = this.config.get<TreeViewDescription[]>("initialViews")
    if (opened) await this.alignWindows(windows, viewsConfigs)
    const treeView = this.view2treeview.get(viewName)
    return treeView.revealDocInTreeView(textDocument, position).then(() => undefined)
  }

  private makeTreeViewPanel(): Promise<void> {
    const initWidth = this.config.get<number>("initialWidth")
    const position = this.config.get<string>("alignment") == "right" ? "botright" : "topleft"
    return this.nvim.command(`silent ${position} vertical ${initWidth} new`)
  }

  private async getOpenWindows(treeViews: string[]): Promise<[Tabpage, WindowWithTree[]]> {
    const curtab = await this.nvim.tabpage
    const windows = await this.nvim.windows
    const openWindows = await Promise.all(treeViews.map(async view => {
      const windowId = await curtab.getVar(view)
      return {name: view, window: windows.find(w => w.id == windowId)} as WindowWithTree
    })).then(ws => ws.filter(w => w.window !== undefined))
    return [curtab, openWindows]
  }

  private async assignOrCreateTreeView(curtab: Tabpage, viewId: string): Promise<Window> {
    const mbTreeView = this.view2treeview.get(viewId)
    if (mbTreeView !== undefined) {
      await this.nvim.command(`buffer ${mbTreeView.bufferId}`)
    } else {
      const buffer = await this.nvim.buffer
      const model = languages.getTreeModel(viewId)
      const treeView = new TreeView(this.nvim, this.config, buffer, model)
      await treeView.init()
      this.view2treeview.set(viewId, treeView)
    }
    const curWindow = await this.nvim.window
    await curtab.setVar(viewId, curWindow.id, false)

    const allTreeViews = (await curtab.getVar('alltreeviews')) as string
    if (allTreeViews === null) {
      await curtab.setVar('alltreeviews', viewId, false)
    } else if (allTreeViews.indexOf(viewId) == -1) {
      await curtab.setVar('alltreeviews', `${allTreeViews},${viewId}`, false)
    }
    return curWindow
  }

  private checkTreeViewAvailability(treeViews: string[]): boolean {
    if (treeViews === undefined || treeViews.length == 0) {
      workspace.showMessage('Information about Tree Views is not yet loaded. Please try a bit later.', 'error')
      return false
    } else {
      return true
    }
  }

  private checkTreeViewExistence(treeViews: string[], viewName: string): boolean {
    if (treeViews.indexOf(viewName) == -1) {
      workspace.showMessage(`Unknown view name ${viewName}. Available values: ${treeViews.join(", ")}`, 'error')
      return false
    } else {
      return true
    }
  }

  private async alignWindows(
    windows: WindowWithTree[],
    viewsConfigs: TreeViewDescription[],
  ): Promise<void> {
    const heights = await Promise.all(windows.map(({window}) => window.height))
    const totalHeight = heights.reduce((acc, num) => acc + num, 0)
    const windowToPart = windows.map(({name: view, window}) => {
      const mbDesc = viewsConfigs.find(c => c.name === view)
      let height: number
      if (mbDesc === undefined) {
        height = viewsConfigs.length != 0
           ? viewsConfigs.reduce((z, c) => Math.min(z, c.size), Number.MAX_VALUE)
           : 10
      } else {
        height = mbDesc.size
      }
      return [window, height] as [Window, number]
    })
    const allParts = windowToPart.map(([_, h]) => h).reduce((n1, n2) => n1 + n2)
    await Promise.all(windowToPart.map(([window, part]) => {
      return window.setHeight(Math.floor(part * totalHeight / allParts))
    }))
  }

  public async toggleTreeViewNode(): Promise<void> {
    return this.doOnActiveTree(treeView => treeView.toggleTreeViewNode())
  }
  public async gotoParentNode(): Promise<void> {
    return this.doOnActiveTree(treeView => treeView.gotoParentNode())
  }
  public async gotoFirstNode(): Promise<void> {
    return this.doOnActiveTree(treeView => treeView.gotoEdgeNode(true))
  }
  public async gotoLastNode(): Promise<void> {
    return this.doOnActiveTree(treeView => treeView.gotoEdgeNode(false))
  }
  public async gotoPrevSibling(): Promise<void> {
    return this.doOnActiveTree(treeView => treeView.gotoNeighboringSibling(true))
  }
  public async gotoNextSibling(): Promise<void> {
    return this.doOnActiveTree(treeView => treeView.gotoNeighboringSibling(false))
  }
  public async executeCommand(): Promise<void> {
    return this.doOnActiveTree(treeView => treeView.executeCommand())
  }

  private async doOnActiveTree(func: (v: TreeView) => Promise<void>): Promise<void> {
    const curBufferId = await this.nvim.eval('bufnr("%")')
    this.view2treeview.values()
    const activeTreeView = [...this.view2treeview.values()].find(view => view.bufferId == curBufferId)
    if (activeTreeView === undefined) {
      return this.nvim.command("echo 'no active tree view'")
    } else {
      return func(activeTreeView)
    }
  }

  private viewsComparator(descs: TreeViewDescription[]): (view1: string, view2: string) => number {
    return (view1: string, view2: string) => {
      const idx1 = descs.findIndex(d => d.name === view1)
      const idx2 = descs.findIndex(d => d.name === view2)
      if (idx1 == -1 && idx2 == -1) return 0
      else if (idx1 == -1) return 1
      else if (idx2 == -1) return -1
      else return idx2 - idx1
    }
  }
}
